// server.js — MakeEazy Tax Analyser Online
// Express + WebSocket + Multer file uploads + AI analysis pipeline

// Global error handlers to prevent Render crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught:', err.message);
  // Don't exit — keep serving
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
});
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');

// Analysis libraries
const { analyzeITR } = require('./lib/analyzer');
const { generateTaxProfile, askAboutTaxpayer } = require('./lib/groq-ai');
const { extractPdfText, parseAISPdfText } = require('./lib/pdf-analyzer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade manually (prevents crash on bad connections)
server.on('upgrade', (request, socket, head) => {
  socket.on('error', () => {}); // Swallow socket errors
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Prevent server from crashing on connection errors
server.on('error', (err) => {
  console.error('[SERVER] Error:', err.message);
});

// ===== CONFIG =====
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB per file (Render-safe)
const MAX_FILES = 15;
const MAX_SESSIONS = 50; // Limit active sessions to prevent OOM

// Ensure temp dir
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ===== MIDDLEWARE =====
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.headers['x-session-id'] || Date.now().toString(36);
    const sessionDir = path.join(TEMP_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    req.sessionDir = sessionDir;
    req.sessionId = sessionId;
    cb(null, sessionDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename but preserve extension
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-()]/g, '_');
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.json', '.pdf'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Only .json and .pdf files are accepted.`));
    }
  }
});

// ===== SESSION STORE =====
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    // Evict oldest session if at limit
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      const dir = path.join(TEMP_DIR, oldest);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
      sessions.delete(oldest);
      console.log(`[SESSION] Evicted oldest session ${oldest} (limit ${MAX_SESSIONS})`);
    }
    sessions.set(id, { id, status: 'idle', files: [], data: null, report: null, aiReport: null });
  }
  return sessions.get(id);
}

// Auto-cleanup old sessions (every 15 min, delete sessions older than 1 hour)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    if (now - (session.createdAt || 0) > 60 * 60 * 1000) {
      const dir = path.join(TEMP_DIR, id);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
      sessions.delete(id);
      cleaned++;
    }
  }
  if (cleaned) console.log(`[CLEANUP] Removed ${cleaned} expired session(s). Active: ${sessions.size}`);
}, 15 * 60 * 1000);

// ===== WEBSOCKET =====
const wsClients = new Map(); // sessionId → Set<ws>

wss.on('connection', (ws, req) => {
  // Extract session ID from URL params
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session') || Date.now().toString(36);
  ws.sessionId = sessionId;

  // Prevent crashes from ws errors
  ws.on('error', () => {});

  if (!wsClients.has(sessionId)) wsClients.set(sessionId, new Set());
  wsClients.get(sessionId).add(ws);

  try { ws.send(JSON.stringify({ type: 'CONNECTED', sessionId })); } catch(e) {}

  ws.on('close', () => {
    const clients = wsClients.get(sessionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) wsClients.delete(sessionId);
    }
  });

  // Handle AI questions via WebSocket
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'AI_QUESTION') {
        const session = getSession(sessionId);
        if (!session.data && !session.report) {
          ws.send(JSON.stringify({ type: 'AI_ANSWER', answer: 'No data available. Please upload and analyze files first.' }));
          return;
        }
        try {
          const reportData = session.report || {};
          const profile = reportData.meta || { pan: session.pan || 'N/A' };
          const itrJsons = session.itrJsons || [];
          const { answer } = await askAboutTaxpayer(msg.question, reportData, profile, itrJsons);
          ws.send(JSON.stringify({ type: 'AI_ANSWER', answer }));
        } catch(e) {
          ws.send(JSON.stringify({ type: 'AI_ANSWER', answer: `Error: ${e.message}` }));
        }
      }
    } catch(e) {}
  });
});

function wsSend(sessionId, data) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch(e) {}
  }
}

// ===== API ROUTES =====

// Upload files
app.post('/api/upload', upload.array('files', MAX_FILES), (req, res) => {
  try {
    const sessionId = req.sessionId || req.headers['x-session-id'] || Date.now().toString(36);
    const session = getSession(sessionId);
    session.createdAt = Date.now();
    session.status = 'uploaded';

    const fileInfos = (req.files || []).map(f => {
      const ext = path.extname(f.originalname).toLowerCase();
      const type = detectFileType(f.originalname, path.join(f.destination, f.filename));
      return {
        name: f.originalname,
        savedAs: f.filename,
        size: f.size,
        ext,
        type // 'itr-json', 'ais-pdf', 'tis-pdf', 'unknown-pdf', 'unknown-json'
      };
    });

    session.files = fileInfos;
    res.json({ sessionId, files: fileInfos, count: fileInfos.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Analyze uploaded files
app.post('/api/analyze', async (req, res) => {
  const { sessionId, pan, dob } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

  const session = getSession(sessionId);
  if (!session.files || session.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded. Upload files first.' });
  }

  session.status = 'analyzing';
  res.json({ status: 'started', message: 'Analysis started. Watch WebSocket for progress.' });

  // Run analysis in background (don't block response)
  runAnalysis(sessionId, pan, dob).catch(err => {
    console.error('Analysis error:', err);
    wsSend(sessionId, { type: 'ERROR', message: err.message });
    session.status = 'error';
  });
});

// Get session status / report
app.get('/api/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  
  const result = {
    status: session.status,
    files: session.files,
    report: session.report || null,
    aiReport: session.aiReport || null
  };
  res.json(result);
});

// Download Excel
app.get('/api/download/excel/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || !session.report) return res.status(404).json({ error: 'No report available' });

  try {
    const { generateExcelReport } = require('./lib/excel-report');
    const wb = await generateExcelReport(session.report, session.aiReport);
    const pan = session.report?.meta?.pan || 'UNKNOWN';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="MakeEazy_${pan}_TaxProfile.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Download ZIP of all files
app.get('/api/download/zip/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const sessionDir = path.join(TEMP_DIR, req.params.sessionId);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'No files' });

  const pan = session.report?.meta?.pan || 'DATA';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="MakeEazy_${pan}_TaxProfile.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);
  archive.directory(sessionDir, false);
  archive.finalize();
});

// AI Question via HTTP (fallback for non-WebSocket)
app.post('/api/ask', async (req, res) => {
  const { sessionId, question } = req.body;
  if (!sessionId || !question) return res.status(400).json({ error: 'sessionId and question required' });

  const session = sessions.get(sessionId);
  if (!session || !session.report) return res.status(404).json({ error: 'No report. Analyze first.' });

  try {
    const reportData = session.report;
    const profile = reportData.meta || { pan: 'N/A' };
    const itrJsons = session.itrJsons || [];
    const { answer } = await askAboutTaxpayer(question, reportData, profile, itrJsons);
    res.json({ answer });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== FILE TYPE DETECTION =====
function detectFileType(filename, filepath) {
  const ext = path.extname(filename).toLowerCase();
  const nameLower = filename.toLowerCase();

  if (ext === '.json') {
    // Check if it's an ITR JSON
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      const data = JSON.parse(content);
      if (data.ITR) return 'itr-json';
      return 'unknown-json';
    } catch(e) {
      return 'unknown-json';
    }
  }

  if (ext === '.pdf') {
    if (nameLower.includes('ais') || nameLower.includes('annual_information') || nameLower.includes('annualinformation')) {
      return 'ais-pdf';
    }
    if (nameLower.includes('tis') || nameLower.includes('taxpayer_information') || nameLower.includes('taxpayerinformation')) {
      return 'tis-pdf';
    }
    // Could be either - we'll try to detect from content later
    return 'unknown-pdf';
  }

  return 'unknown';
}

// ===== ANALYSIS PIPELINE =====
async function runAnalysis(sessionId, providedPan, providedDob) {
  const session = getSession(sessionId);
  const sessionDir = path.join(TEMP_DIR, sessionId);
  const send = (data) => wsSend(sessionId, data);

  send({ type: 'PROGRESS', step: 1, total: 8, message: 'Scanning uploaded files...' });
  send({ type: 'LOG', message: '═══ PHASE 1: File Processing ═══', level: 'HL' });

  // Categorize files
  const itrJsonFiles = session.files.filter(f => f.type === 'itr-json');
  const pdfFiles = session.files.filter(f => f.ext === '.pdf');
  const unknownJsonFiles = session.files.filter(f => f.type === 'unknown-json');

  send({ type: 'LOG', message: `Found: ${itrJsonFiles.length} ITR JSON(s), ${pdfFiles.length} PDF(s), ${unknownJsonFiles.length} other JSON(s)` });

  // PHASE 1: Parse ITR JSONs
  send({ type: 'PROGRESS', step: 2, total: 8, message: 'Parsing ITR JSON files...' });
  const itrResults = [];
  let detectedPan = providedPan || '';

  for (const file of itrJsonFiles) {
    try {
      const filePath = path.join(sessionDir, file.savedAs);
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Handle potentially large JSON files - parse in try/catch
      let jsonData;
      try {
        jsonData = JSON.parse(content);
      } catch(e) {
        send({ type: 'LOG', message: `  ✗ ${file.name}: Invalid JSON - ${e.message}`, level: 'ERR' });
        itrResults.push({ success: false, error: 'Invalid JSON', jsonData: null, ay: '', itrType: '' });
        continue;
      }

      // Detect AY and ITR type
      const itrKey = jsonData.ITR ? Object.keys(jsonData.ITR)[0] : null;
      if (!itrKey) {
        send({ type: 'LOG', message: `  ✗ ${file.name}: Not a valid ITR JSON (no ITR key)`, level: 'ERR' });
        itrResults.push({ success: false, error: 'Not valid ITR', jsonData: null, ay: '', itrType: '' });
        continue;
      }

      const itrData = jsonData.ITR[itrKey];
      
      // Extract AY from filing status or filename
      let ay = '';
      const fs_data = itrData.FilingStatus || itrData.PartA_GEN1?.FilingStatus || {};
      ay = fs_data.AssessmentYear || fs_data.AYForWhichFiled || '';
      if (!ay) {
        const ayMatch = file.name.match(/(\d{4}-\d{2})/);
        if (ayMatch) ay = ayMatch[1];
      }

      // Extract PAN
      if (!detectedPan) {
        const pi = itrData.PartA_GEN1?.PersonalInfo || itrData.PersonalInfo || itrData.PartA_GEN?.PersonalInfo || {};
        const panField = itrData.PartA_GEN1?.FilingStatus?.PAN || pi.PAN || '';
        if (panField && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panField)) {
          detectedPan = panField;
        }
        // Also try from filename
        if (!detectedPan) {
          const panMatch = file.name.match(/([A-Z]{5}[0-9]{4}[A-Z])/);
          if (panMatch) detectedPan = panMatch[1];
        }
      }

      send({ type: 'LOG', message: `  ✓ ${file.name} → ${itrKey} | AY: ${ay || 'Unknown'}`, level: 'OK' });
      itrResults.push({
        success: true,
        jsonData,
        itrType: itrKey,
        ay: ay || 'Unknown',
        ackNum: fs_data.AcknowledgementNo || fs_data.OrigRetFiledDate || '',
        filingDate: fs_data.FilingDate || ''
      });

    } catch(e) {
      send({ type: 'LOG', message: `  ✗ ${file.name}: ${e.message}`, level: 'ERR' });
      itrResults.push({ success: false, error: e.message, jsonData: null, ay: '', itrType: '' });
    }
  }

  // Also try unknown JSONs (might be ITR data in different format or report JSONs)
  for (const file of unknownJsonFiles) {
    try {
      const filePath = path.join(sessionDir, file.savedAs);
      const content = fs.readFileSync(filePath, 'utf8');
      const jsonData = JSON.parse(content);
      
      // Check if it's a previously generated report.json or taxpayer profile
      if (jsonData.meta?.pan || jsonData.yearlyITR) {
        send({ type: 'LOG', message: `  ℹ ${file.name}: Detected as previous MakeEazy report`, level: 'OK' });
        // Use this as supplementary data
        if (!detectedPan && jsonData.meta?.pan) detectedPan = jsonData.meta.pan;
      }
    } catch(e) {}
  }

  session.pan = detectedPan;
  session.itrJsons = itrResults.filter(r => r.success).map(r => r.jsonData);

  // PHASE 2: Parse PDFs
  send({ type: 'PROGRESS', step: 3, total: 8, message: 'Extracting data from PDFs...' });
  send({ type: 'LOG', message: '', level: 'BLANK' });
  send({ type: 'LOG', message: '═══ PHASE 2: PDF Extraction ═══', level: 'HL' });

  const tisData = {};
  const pdfTexts = {};

  // Build PDF password from PAN + DOB
  let pdfPassword = '';
  if (detectedPan && providedDob) {
    let dd, mm, yyyy;
    if (providedDob.includes('-') && providedDob.indexOf('-') === 4) {
      [yyyy, mm, dd] = providedDob.split('-');
    } else if (providedDob.includes('/')) {
      [dd, mm, yyyy] = providedDob.split('/');
    } else if (providedDob.includes('-')) {
      [dd, mm, yyyy] = providedDob.split('-');
    }
    if (dd && mm && yyyy) {
      pdfPassword = detectedPan.toLowerCase() + dd + mm + yyyy;
    }
  }
  // Also try extracting DOB from parsed ITR data
  if (!pdfPassword && detectedPan) {
    for (const itr of itrResults) {
      if (!itr.success || !itr.jsonData) continue;
      const itrKey = Object.keys(itr.jsonData.ITR)[0];
      const d = itr.jsonData.ITR[itrKey];
      const pi = d.PartA_GEN1?.PersonalInfo || d.PersonalInfo || d.PartA_GEN?.PersonalInfo || {};
      const dob = pi.DOB || '';
      if (dob) {
        let dd, mm, yyyy;
        if (dob.includes('-') && dob.indexOf('-') === 4) {
          [yyyy, mm, dd] = dob.split('-');
        } else if (dob.includes('/')) {
          [dd, mm, yyyy] = dob.split('/');
        } else if (dob.includes('-')) {
          [dd, mm, yyyy] = dob.split('-');
        }
        if (dd && mm && yyyy) {
          pdfPassword = detectedPan.toLowerCase() + dd + mm + yyyy;
          break;
        }
      }
    }
  }

  for (const file of pdfFiles) {
    try {
      const filePath = path.join(sessionDir, file.savedAs);
      send({ type: 'LOG', message: `  Processing: ${file.name}...` });

      // Try without password first, then with password
      let pdfResult = null;
      const passwords = ['', pdfPassword].filter(Boolean);
      // Also try common passwords
      if (detectedPan) passwords.push(detectedPan.toLowerCase());

      for (const pwd of passwords) {
        try {
          pdfResult = await extractPdfText(filePath, pwd || undefined);
          if (pdfResult && pdfResult.text.length > 50) break;
        } catch(e) {
          // If password error, try next
          if (e.message.includes('password') || e.message.includes('Password') || e.message.includes('encrypted')) {
            continue;
          }
          // Other error - might be a scanned/image PDF
          send({ type: 'LOG', message: `    ⚠ Parse error: ${e.message.substring(0, 80)}`, level: 'WARN' });
          break;
        }
      }

      if (!pdfResult || pdfResult.text.length < 50) {
        send({ type: 'LOG', message: `  ✗ ${file.name}: Could not extract text (might need password or is image-based)`, level: 'WARN' });
        continue;
      }

      // Save extracted text
      const txtFile = file.savedAs.replace('.pdf', '_text.txt').replace('.PDF', '_text.txt');
      fs.writeFileSync(path.join(sessionDir, txtFile), pdfResult.text);

      // Parse AIS/TIS content
      const parsed = parseAISPdfText(pdfResult.text, file.type === 'ais-pdf');

      // Detect FY from filename or content
      let fy = '';
      const fyMatch = file.name.match(/(\d{4}-\d{2,4})/);
      if (fyMatch) {
        fy = fyMatch[1];
        if (fy.length === 9) fy = fy.substring(0, 7); // 2024-2025 → 2024-25
      }
      if (!fy) {
        const fyContent = pdfResult.text.match(/(?:Financial|FY|F\.Y\.)\s*[:\-]?\s*(\d{4}-\d{2,4})/i);
        if (fyContent) {
          fy = fyContent[1];
          if (fy.length === 9) fy = fy.substring(0, 7);
        }
      }
      if (!fy) fy = `PDF-${pdfFiles.indexOf(file) + 1}`;

      const catCount = Object.keys(parsed.categories).length;
      if (catCount > 0) {
        tisData[fy] = { categories: parsed.categories, source: 'pdf', file: file.name };
        send({ type: 'LOG', message: `  ✓ ${file.name} → F.Y. ${fy}: ${catCount} categories extracted`, level: 'OK' });
      } else {
        send({ type: 'LOG', message: `  ℹ ${file.name}: PDF parsed (${pdfResult.pages} pages) but no structured data found`, level: 'WARN' });
      }

      // Store text for AI analysis
      pdfTexts[file.name] = pdfResult.text;

    } catch(e) {
      send({ type: 'LOG', message: `  ✗ ${file.name}: ${e.message}`, level: 'ERR' });
    }
  }

  // PHASE 3: Build Report using analyzer.js
  send({ type: 'PROGRESS', step: 4, total: 8, message: 'Building tax profile...' });
  send({ type: 'LOG', message: '', level: 'BLANK' });
  send({ type: 'LOG', message: '═══ PHASE 3: Building Profile ═══', level: 'HL' });

  let report = null;
  const profile = { pan: detectedPan || 'N/A', name: '', dob: '' };

  if (itrResults.filter(r => r.success).length > 0) {
    try {
      report = analyzeITR(itrResults, tisData, profile);
      send({ type: 'LOG', message: `Profile built: ${report.summary.downloaded} return(s) analyzed`, level: 'OK' });
      
      // Save report
      fs.writeFileSync(path.join(sessionDir, 'report.json'), JSON.stringify(report, null, 2));
    } catch(e) {
      send({ type: 'LOG', message: `Profile build error: ${e.message}`, level: 'ERR' });
    }
  } else if (Object.keys(tisData).length > 0) {
    // Only PDFs uploaded — create a minimal report
    report = {
      meta: { pan: detectedPan || 'N/A', generatedAt: new Date().toISOString(), version: '1.0-online' },
      summary: { totalReturns: 0, downloaded: 0, failed: 0, itrTypesUsed: {}, tisYears: Object.keys(tisData).length },
      yearlyITR: [],
      tisData,
      crossVerification: []
    };
    send({ type: 'LOG', message: 'No ITR JSONs — profile built from PDF data only', level: 'WARN' });
  } else {
    send({ type: 'ERROR', message: 'No valid ITR JSONs or AIS/TIS PDFs found. Please upload valid files.' });
    session.status = 'error';
    return;
  }

  session.report = report;

  // Send intermediate report data immediately
  send({ type: 'REPORT_DATA', report });

  // PHASE 4: AI Analysis
  send({ type: 'PROGRESS', step: 5, total: 8, message: '🤖 Running AI analysis...' });
  send({ type: 'LOG', message: '', level: 'BLANK' });
  send({ type: 'LOG', message: '═══ PHASE 4: AI Analysis ═══', level: 'HL' });

  let aiReport = null;
  try {
    const itrJsons = itrResults.filter(r => r.success).map(r => r.jsonData);
    
    // Truncate PDF texts to avoid token limits
    const truncatedPdfTexts = {};
    for (const [key, text] of Object.entries(pdfTexts)) {
      truncatedPdfTexts[key] = text.substring(0, 3000); // Keep first 3K chars per PDF
    }

    send({ type: 'LOG', message: 'Sending data to AI for deep analysis...', level: 'OK' });
    
    aiReport = await generateTaxProfile(report, itrJsons, truncatedPdfTexts, profile);
    
    if (aiReport && (aiReport.taxpayerProfile || aiReport.executiveSummary)) {
      send({ type: 'LOG', message: '✅ AI analysis complete!', level: 'OK' });
    } else {
      send({ type: 'LOG', message: '⚠️ AI returned partial results', level: 'WARN' });
    }

    // Save AI report
    fs.writeFileSync(path.join(sessionDir, 'ai_report.json'), JSON.stringify(aiReport, null, 2));
    
  } catch(e) {
    send({ type: 'LOG', message: `⚠️ AI analysis error: ${e.message}`, level: 'WARN' });
    send({ type: 'LOG', message: 'Report generated without AI insights.', level: 'WARN' });
    aiReport = {
      parseError: true,
      executiveSummary: 'AI analysis could not be completed. The report contains all extracted data from your files.',
      _error: e.message
    };
  }

  session.aiReport = aiReport;

  // PHASE 5: Final
  send({ type: 'PROGRESS', step: 8, total: 8, message: 'Done!' });
  send({ type: 'LOG', message: '', level: 'BLANK' });
  send({ type: 'LOG', message: '═══════════════════════════════', level: 'OK' });
  send({ type: 'LOG', message: '  ✅ ANALYSIS COMPLETE', level: 'OK' });
  send({ type: 'LOG', message: '═══════════════════════════════', level: 'OK' });

  send({ type: 'AI_REPORT', report: aiReport });
  send({ type: 'COMPLETE', report, aiReport });

  session.status = 'done';
}

// ===== MULTER ERROR HANDLER =====
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 25MB per file)' });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ error: 'Too many files (max 15)' });
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(500).json({ error: err.message });
  next();
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
const listener = server.listen(PORT, () => {
  const p = listener.address().port;
  console.log(`\n  ╔═══════════════════════════════════════════╗`);
  console.log(`  ║  MakeEazy Tax Analyser Online              ║`);
  console.log(`  ║  📊 Upload PDFs & JSONs → Get AI Profile   ║`);
  console.log(`  ║  🌐 Open: http://localhost:${p}              ║`);
  console.log(`  ╚═══════════════════════════════════════════╝\n`);
});
