// app.js — MakeEazy Tax Profiler Online
// Upload → WebSocket Progress → Full Report Dashboard
// Based on desktop exe version — same report rendering, upload replaces auto-download

const $ = id => document.getElementById(id);

let ws, sessionId, reportData = null, aiReportData = null;
let uploadedFiles = [];

// ===== Simulated Progress State =====
let simProgress = 0, simTarget = 0, simInterval = null, factTimer = null;
let currentPhaseLabel = 'Initializing...';

// ===== ITR Facts =====
const itrFacts = [
  "India has over 7.28 crore ITR filers as of 2024.",
  "The last date to file ITR is usually July 31 every year.",
  "Under New Regime (FY 2024-25), income up to ₹7 lakh is tax-free with rebate u/s 87A.",
  "Section 80C allows deductions up to ₹1.5 lakh for PPF, ELSS, LIC, etc. under Old Regime.",
  "ITR-1 (Sahaj) is the most commonly filed return form in India.",
  "You can carry forward capital losses for up to 8 assessment years.",
  "The Income Tax department can scrutinize returns up to 6 years old.",
  "Health & Education Cess of 4% is added on top of the income tax amount.",
  "Standard deduction of ₹75,000 is available for salaried individuals from FY 2024-25.",
  "Filing ITR is mandatory if your gross income exceeds ₹2.5 lakh (Old Regime).",
  "Under New Regime, the basic exemption limit is ₹3 lakh.",
  "Section 80D allows deductions for medical insurance — up to ₹25,000 (₹50,000 for seniors).",
  "TDS certificates (Form 16/16A) are key documents for ITR filing.",
  "AIS (Annual Information Statement) replaced Form 26AS as the primary tax information document.",
  "NRIs must file ITR in India if their Indian income exceeds ₹2.5 lakh.",
  "Belated returns can be filed up to December 31 of the assessment year with a penalty.",
  "Presumptive taxation (Sec 44AD) allows businesses with turnover up to ₹3 crore to declare 6-8% profit."
];
let factIndex = 0;

function rotateFact() {
  const el = $('factText');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => {
    factIndex = (factIndex + 1) % itrFacts.length;
    el.textContent = itrFacts[factIndex];
    el.style.opacity = '1';
  }, 400);
}

// ===== FILE UPLOAD =====
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const fileList = $('fileList');
const btnAnalyze = $('btnAnalyze');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

function handleFiles(files) {
  let hasJson = false;
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['json', 'pdf'].includes(ext)) continue;
    if (uploadedFiles.find(f => f.name === file.name)) continue;
    uploadedFiles.push(file);
    if (ext === 'json') hasJson = true;
  }
  renderFileList();
  // Must have at least 1 JSON file
  const jsonCount = uploadedFiles.filter(f => f.name.toLowerCase().endsWith('.json')).length;
  btnAnalyze.disabled = jsonCount === 0;
  if (uploadedFiles.length > 0) {
    $('optionalFields').style.display = '';
  }
}

function renderFileList() {
  fileList.innerHTML = uploadedFiles.map((f, i) => {
    const ext = f.name.split('.').pop().toLowerCase();
    const name = f.name.toLowerCase();
    let type = ext === 'json' ? 'ITR JSON' : 'PDF';
    let typeClass = ext === 'json' ? 'itr' : 'unknown';
    if (ext === 'pdf') {
      if (name.includes('ais')) { type = 'AIS PDF'; typeClass = 'ais'; }
      else if (name.includes('tis')) { type = 'TIS PDF'; typeClass = 'tis'; }
      else { type = 'PDF'; typeClass = 'unknown'; }
    }
    const size = f.size > 1024 * 1024
      ? (f.size / 1024 / 1024).toFixed(1) + ' MB'
      : (f.size / 1024).toFixed(0) + ' KB';
    const icon = ext === 'json' ? '📄' : '📑';
    return `<div class="file-item-upload">
      <span class="fu-icon">${icon}</span>
      <div class="fu-info">
        <div class="fu-name">${escHtml(f.name)}</div>
        <div class="fu-meta">${size}</div>
      </div>
      <span class="fu-type ${typeClass}">${type}</span>
      <button class="fu-remove" data-idx="${i}" title="Remove">&times;</button>
    </div>`;
  }).join('');

  fileList.querySelectorAll('.fu-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.dataset.idx);
      uploadedFiles.splice(idx, 1);
      renderFileList();
      const jsonCount = uploadedFiles.filter(f => f.name.toLowerCase().endsWith('.json')).length;
      btnAnalyze.disabled = jsonCount === 0;
      if (uploadedFiles.length === 0) $('optionalFields').style.display = 'none';
    });
  });
}

// ===== ANALYZE =====
btnAnalyze.addEventListener('click', startAnalysis);

async function startAnalysis() {
  const jsonCount = uploadedFiles.filter(f => f.name.toLowerCase().endsWith('.json')).length;
  if (jsonCount === 0) {
    alert('At least 1 ITR JSON file is mandatory for analysis.');
    return;
  }

  btnAnalyze.disabled = true;
  btnAnalyze.innerHTML = '<span class="spinner"></span> Uploading...';

  sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const formData = new FormData();
  for (const file of uploadedFiles) {
    formData.append('files', file);
  }

  try {
    const uploadResp = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-session-id': sessionId },
      body: formData
    });
    const uploadResult = await uploadResp.json();
    if (!uploadResp.ok) throw new Error(uploadResult.error || 'Upload failed');

    sessionId = uploadResult.sessionId;

    // Switch to processing screen
    $('uploadSection').style.display = 'none';
    $('progressSection').style.display = 'block';
    $('statusMsg').textContent = '';
    $('statusMsg').className = 'status-msg';

    // Start simulated progress
    startSimulatedProgress();

    // Add SVG gradient for ring
    const svg = document.querySelector('.progress-ring');
    if (svg && !document.getElementById('ringGrad')) {
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML = '<linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#32509F"/><stop offset="100%" stop-color="#F77F00"/></linearGradient>';
      svg.prepend(defs);
    }

    // Connect WebSocket
    connectWS(sessionId);

    // Trigger analysis
    const pan = $('panInput').value.trim().toUpperCase();
    const dob = $('dobInput').value;

    const analyzeResp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, pan: pan || undefined, dob: dob || undefined })
    });
    const analyzeResult = await analyzeResp.json();
    if (!analyzeResp.ok) throw new Error(analyzeResult.error || 'Analysis failed');

  } catch (err) {
    alert('Error: ' + err.message);
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML = '<span>⚡</span> Analyze Now';
    $('progressSection').style.display = 'none';
    $('uploadSection').style.display = 'flex';
    stopSimulatedProgress();
  }
}

// ===== WEBSOCKET =====
function connectWS(sid) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/?session=${sid}`);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch(e) {}
  };

  ws.onclose = () => {
    setTimeout(() => {
      if ($('progressSection').style.display === 'block') {
        connectWS(sid);
      }
    }, 2000);
  };

  ws.onerror = () => {};
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'PROGRESS': {
      const realPct = Math.round((msg.step / msg.total) * 100);
      const mappedTarget = Math.min(15 + (realPct * 0.8), 95);
      if (mappedTarget > simTarget) simTarget = mappedTarget;
      $('statusMsg').textContent = msg.message || '';
      $('statusMsg').className = 'status-msg status';
      break;
    }
    case 'LOG':
      if (msg.level === 'ERROR' || msg.level === 'WARN' || msg.level === 'SUCCESS') {
        $('statusMsg').textContent = msg.message || '';
        $('statusMsg').className = `status-msg ${(msg.level || '').toLowerCase()}`;
      }
      if (simTarget < 92) simTarget = Math.min(simTarget + 2, 92);
      break;
    case 'REPORT_DATA':
      reportData = msg.report;
      simTarget = 80;
      break;
    case 'AI_REPORT':
      aiReportData = msg.report;
      simTarget = 95;
      break;
    case 'COMPLETE':
      reportData = msg.report || reportData;
      aiReportData = msg.aiReport || aiReportData;
      stopSimulatedProgress();
      animateToComplete();
      break;
    case 'ERROR':
      $('statusMsg').textContent = '❌ ' + msg.message;
      $('statusMsg').className = 'status-msg error';
      if (reportData) {
        stopSimulatedProgress();
        animateToComplete();
      }
      break;
    case 'AI_ANSWER':
      renderAIAnswer(msg.answer);
      break;
  }
}

// ===== SIMULATED PROGRESS =====
const phaseLabels = [
  { at: 0,  label: 'Initializing...' },
  { at: 5,  label: 'Connecting to server...' },
  { at: 12, label: 'Processing uploaded files...' },
  { at: 20, label: 'Parsing ITR JSON data...' },
  { at: 30, label: 'Extracting PDF content...' },
  { at: 40, label: 'Analyzing income sources...' },
  { at: 50, label: 'Computing deductions...' },
  { at: 58, label: 'Calculating tax liability...' },
  { at: 65, label: 'Cross-verifying with TIS...' },
  { at: 72, label: 'Running AI deep analysis...' },
  { at: 80, label: 'Building tax profile...' },
  { at: 88, label: 'Generating insights...' },
  { at: 95, label: 'Finalizing report...' }
];

function startSimulatedProgress() {
  simProgress = 0;
  simTarget = 15;

  factIndex = Math.floor(Math.random() * itrFacts.length);
  $('factText').textContent = itrFacts[factIndex];
  factTimer = setInterval(rotateFact, 5000);

  simInterval = setInterval(() => {
    const diff = simTarget - simProgress;
    if (diff > 0) {
      const step = Math.max(0.1, diff * 0.04);
      simProgress = Math.min(simProgress + step, simTarget);
    }
    if (simTarget < 88) simTarget += 0.02;

    const displayPct = Math.round(simProgress);
    updateProgressRing(displayPct);

    for (let i = phaseLabels.length - 1; i >= 0; i--) {
      if (displayPct >= phaseLabels[i].at) {
        if (currentPhaseLabel !== phaseLabels[i].label) {
          currentPhaseLabel = phaseLabels[i].label;
          $('progressLabel').textContent = currentPhaseLabel;
        }
        break;
      }
    }
  }, 80);
}

function stopSimulatedProgress() {
  if (simInterval) { clearInterval(simInterval); simInterval = null; }
  if (factTimer) { clearInterval(factTimer); factTimer = null; }
}

function animateToComplete() {
  const startPct = simProgress;
  const startTime = performance.now();
  const duration = 600;

  function tick(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const currentPct = Math.round(startPct + (100 - startPct) * eased);
    updateProgressRing(currentPct);

    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      updateProgressRing(100);
      $('progressLabel').textContent = '✅ Analysis Complete!';
      setTimeout(() => showReport(), 600);
    }
  }
  requestAnimationFrame(tick);
}

function updateProgressRing(pct) {
  const ring = $('progressRing');
  if (ring) {
    const circumference = 2 * Math.PI * 52;
    ring.style.strokeDashoffset = circumference - (pct / 100) * circumference;
  }
  $('progressPercent').textContent = pct + '%';
}

// ===== REPORT =====
function showReport() {
  $('progressSection').style.display = 'none';
  $('reportSection').style.display = 'block';
  $('reportSection').classList.add('fade-in');
  renderFullReport();
}

function renderFullReport() {
  if (!reportData) return;
  const r = reportData;

  renderComputation(r);
  renderIncomeTrend(r);
  renderTISData(r);
  renderMismatchFromTIS(r);

  if (aiReportData && !aiReportData.parseError) {
    renderFullAIReport(aiReportData);
  } else {
    showSkeletonLoaders();
  }
}

function showSkeletonLoaders() {
  const skeleton = `<div class="skeleton-loader"><div class="skel-line w80"></div><div class="skel-line w60"></div><div class="skel-line w90"></div><div class="skel-line w40"></div></div>`;
  if (!aiReportData) {
    $('aiSummary').innerHTML = skeleton;
    $('profileCards').innerHTML = `<div class="profile-card skeleton-loader"><div class="skel-line w60"></div><div class="skel-line w80"></div></div>`.repeat(4);
    $('compliancePanel').innerHTML = `<h4>✅ Compliance</h4>${skeleton}`;
    $('riskPanel').innerHTML = `<h4>🚨 Red Flags</h4>${skeleton}`;
    $('optimizationContainer').innerHTML = skeleton;
    $('mismatchContainer').innerHTML = skeleton;
  }
}

// ===== Render Full AI Report (from desktop exe) =====
function renderFullAIReport(report) {
  if (!report || report.parseError) return;

  // Executive Summary
  let summary = '';
  if (typeof report.executiveSummary === 'string') summary = report.executiveSummary;
  else if (report.executiveSummary?.keyFindings) summary = report.executiveSummary.keyFindings.join('. ');
  else if (typeof report.executiveSummary === 'object') summary = Object.values(report.executiveSummary).filter(v => typeof v === 'string').join('. ');
  $('aiSummary').innerHTML = formatText(summary || 'Analysis generated.');
  $('aiMeta').textContent = `Generated ${new Date().toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' })}`;

  // Profile Cards
  const tp = report.taxpayerProfile || {};
  const risk = tp.riskScore ?? '-';
  const riskColor = risk <= 30 ? 'green' : risk <= 60 ? 'orange' : 'red';
  const compliance = report.complianceCheck?.overallStatus || report.overallCompliance || '-';
  const compColor = compliance.toLowerCase().includes('non') ? 'red' : compliance.toLowerCase().includes('partial') ? 'orange' : 'green';
  $('profileCards').innerHTML = `
    <div class="profile-card"><div class="label">TAXPAYER</div><div class="value blue">${tp.name || reportData?.meta?.name || '-'}</div><div class="sub">${tp.pan || ''} ${tp.dob ? '• DOB: '+tp.dob : ''}</div></div>
    <div class="profile-card"><div class="label">CATEGORY</div><div class="value">${tp.category || 'Individual'}</div><div class="sub">${tp.summaryLine || ''}</div></div>
    <div class="profile-card"><div class="label">RISK SCORE</div><div class="value ${riskColor}">${risk}/100</div><div class="sub">${risk <= 30 ? 'Low Risk' : risk <= 60 ? 'Medium Risk' : 'High Risk'}</div></div>
    <div class="profile-card"><div class="label">COMPLIANCE</div><div class="value ${compColor}">${compliance}</div><div class="sub">${report.complianceCheck?.checks?.length || 0} checks</div></div>`;

  // Compliance section
  const checks = report.complianceCheck?.checks || [];
  $('compliancePanel').innerHTML = `<h4>✅ Compliance</h4>${checks.map(c => `<div class="check-item"><span class="check-dot ${(c.status||'').toLowerCase().includes('pass')||(c.status||'').toLowerCase().includes('compliant')||(c.status||'').toLowerCase().includes('ok')?'pass':'fail'}"></span><div><div class="check-name">${c.check||c.item||''}</div><div class="check-detail">${c.detail||c.remarks||c.description||''}</div></div></div>`).join('')}`;

  // Red Flags
  const flags = report.redFlags || [];
  $('riskPanel').innerHTML = `<h4>🚨 Red Flags</h4>${!flags.length ? '<p style="color:var(--green)">✅ No red flags</p>' :
    flags.map(f => `<div class="risk-item"><div class="risk-flag">${f.flag||f.title||''}</div><span class="risk-badge ${(f.severity||'low').toLowerCase()}">${f.severity||'Low'}</span><div class="risk-detail">${f.detail||f.description||''}</div></div>`).join('')}`;

  // Optimization
  const opt = report.taxOptimization || {};
  const recs = opt.recommendations || [];
  $('optimizationContainer').innerHTML = `<div style="padding:16px;background:var(--glass);border-radius:10px;margin-bottom:16px;">
    <p><strong>Current:</strong> ${opt.currentRegime||'N/A'} → <strong>Optimal:</strong> <span style="color:var(--green)">${opt.optimalRegime||'N/A'}</span></p>
    ${opt.potentialSavings ? `<p style="color:var(--green);font-weight:700;margin-top:4px;">💰 Savings: ₹${fmt(opt.potentialSavings)}</p>` : ''}</div>
    <h4 style="margin-bottom:10px">💡 Recommendations</h4>
    ${(Array.isArray(recs)?recs:[]).map(r => typeof r==='string' ? `<div class="opt-card"><div class="opt-desc">${formatText(r)}</div></div>` :
      `<div class="opt-card"><div class="opt-title">${r.priority?`<span class="opt-priority ${r.priority}">${r.priority}</span>`:''} ${r.title||r.recommendation||'Tip'}</div><div class="opt-desc">${formatText(r.description||r.detail||'')}</div>${r.potentialSaving?`<div class="opt-saving">💰 ₹${fmt(r.potentialSaving)}</div>`:''}</div>`
    ).join('') || '<p style="color:var(--text2)">No recommendations</p>'}`;

  // Remove skeletons
  document.querySelectorAll('.skeleton-loader').forEach(s => s.remove());
}

// ===== Income Trend (from desktop exe — identical) =====
function deduplicateYears(years) {
  const byAY = {};
  for (const y of years) {
    const existing = byAY[y.ay];
    if (!existing) {
      byAY[y.ay] = y;
    } else {
      const yIsRevised = (y.filingType || '').includes('Revised') || (y.filingType || '').includes('139(5)');
      const exIsRevised = (existing.filingType || '').includes('Revised') || (existing.filingType || '').includes('139(5)');
      if (yIsRevised && !exIsRevised) byAY[y.ay] = y;
      else if (!yIsRevised && exIsRevised) { /* keep existing */ }
      else if (String(y.ackNum || '') > String(existing.ackNum || '')) byAY[y.ay] = y;
    }
  }
  return Object.values(byAY).sort((a, b) => (b.ay || '').localeCompare(a.ay || ''));
}

function renderIncomeTrend(report) {
  const allYears = (report.yearlyITR || []).slice().sort((a,b) => (b.ay||'').localeCompare(a.ay||''));
  if (!allYears.length) { $('incomeContainer').innerHTML = '<p style="color:var(--text2)">No trend data</p>'; return; }
  const latestAcks = {};
  const latestByAY = {};
  for (const y of allYears) {
    const existing = latestByAY[y.ay];
    if (!existing) {
      latestByAY[y.ay] = y; latestAcks[y.ay] = y.ackNum;
    } else {
      const yIsRevised = (y.filingType || '').includes('Revised') || (y.filingType || '').includes('139(5)');
      const exIsRevised = (existing.filingType || '').includes('Revised') || (existing.filingType || '').includes('139(5)');
      if (yIsRevised && !exIsRevised) { latestByAY[y.ay] = y; latestAcks[y.ay] = y.ackNum; }
      else if (!yIsRevised && exIsRevised) { /* keep existing */ }
      else if (String(y.ackNum||'') > String(existing.ackNum||'')) { latestByAY[y.ay] = y; latestAcks[y.ay] = y.ackNum; }
    }
  }
  $('incomeContainer').innerHTML = `<h4 style="margin-bottom:12px">📈 Year-wise Summary</h4>
    <table class="data-table"><thead><tr><th>AY</th><th>ITR</th><th>Filing</th><th>Regime</th><th style="text-align:right">Gross</th><th style="text-align:right">Taxable</th><th style="text-align:right">Tax</th><th style="text-align:right">TDS</th><th style="text-align:right">Refund</th></tr></thead>
    <tbody>${allYears.map(y=>{
      const isSuperseded = latestAcks[y.ay] && String(y.ackNum||'') !== String(latestAcks[y.ay]||'');
      const style = isSuperseded ? ' style="opacity:0.5;font-style:italic"' : '';
      const badge = isSuperseded ? ' <span style="font-size:10px;color:var(--text2)">(Superseded)</span>' : ' <span style="font-size:10px;color:var(--green)">(Latest)</span>';
      return `<tr${style}><td><strong>${y.ay||''}</strong>${(allYears.filter(x=>x.ay===y.ay).length>1)?badge:''}</td><td>${y.itrType||y.detectedType||''}</td><td style="font-size:11px">${y.filingType||''}</td><td>${y.regime||''}</td><td style="text-align:right">₹${fmt(y.grossTotal)}</td><td style="text-align:right">₹${fmt(y.totalIncome)}</td><td style="text-align:right">₹${fmt(y.tax?.totalLiability||y.tax?.onIncome)}</td><td style="text-align:right;color:var(--green)">₹${fmt(y.tax?.tds)}</td><td style="text-align:right;color:${y.tax?.refund?'var(--green)':'var(--text2)'}">₹${fmt(y.tax?.refund)}</td></tr>`;
    }).join('')}</tbody></table>`;
}

// ===== Computation Tab — Side-by-Side (from desktop exe — identical) =====
function renderComputation(report) {
  const years = deduplicateYears(report.yearlyITR || []);
  if (!years.length) { $('computationContainer').innerHTML = '<p style="color:var(--text2)">No ITR data. Upload ITR JSON files.</p>'; return; }
  renderComputationSideBySide(years);
}

function renderComputationSideBySide(years) {
  const hdr = years.map(y => {
    const rc = (y.regime||'').includes('New') ? 'regime-new' : 'regime-old';
    return `<th style="text-align:right;min-width:120px"><strong>AY ${y.ay}</strong><br><span class="comp-tag">${y.itrType||y.detectedType||''}</span> <span class="comp-tag ${rc}">${y.regime||''}</span></th>`;
  }).join('');

  function row(label, getter, opts = {}) {
    const vals = years.map(y => getter(y));
    if (vals.every(v => !v && v !== 0) && !opts.always) return '';
    const cls = opts.total ? 'comp-total' : opts.subtotal ? 'comp-subtotal' : '';
    return `<tr class="${cls}"><td>${opts.bold ? '<strong>'+label+'</strong>' : label}</td>${vals.map(v => {
      const color = opts.color || (opts.negative && v < 0 ? 'var(--red)' : opts.green ? 'var(--green)' : '');
      return `<td style="text-align:right;${color?'color:'+color:''}">${opts.bold ? '<strong>' : ''}${opts.prefix||''}${fmt(v)}${opts.bold ? '</strong>' : ''}</td>`;
    }).join('')}</tr>`;
  }

  let html = `<table class="data-table comp-side"><thead><tr><th>Particulars</th>${hdr}</tr></thead><tbody>`;
  html += `<tr><td colspan="${years.length+1}" style="background:var(--glass);font-weight:600;padding:8px 12px">📊 Income Heads</td></tr>`;
  html += row('Income from Salary', y => y.income?.salary);
  html += row('House Property', y => y.income?.houseProperty, { negative: true });
  html += row('Business/Profession', y => y.income?.businessProfession);
  html += row('Capital Gains (STCG)', y => y.income?.capitalGains?.stcg);
  html += row('Capital Gains (LTCG)', y => y.income?.capitalGains?.ltcg);
  html += row('Dividend Income', y => y.income?.dividend);
  html += row('Other Sources', y => y.income?.otherSources);
  html += row('Gross Total Income', y => y.grossTotal, { total: true, bold: true, always: true });

  // Business Details
  const hasBiz = years.some(y => y.schedules?.business && (y.schedules.business.grossSales > 0 || y.schedules.business.sec44AD?.totalTurnover > 0 || y.schedules.business.sec44ADA?.grossReceipts > 0));
  if (hasBiz) {
    html += `<tr><td colspan="${years.length+1}" style="background:var(--glass);font-weight:600;padding:8px 12px">🏢 Business Details</td></tr>`;
    const bizType = years.find(y => y.schedules?.business)?.schedules.business.type;
    if (bizType === 'Presumptive') {
      html += row('44AD Turnover (Cash)', y => y.schedules?.business?.sec44AD?.turnoverCash);
      html += row('44AD Turnover (Digital)', y => y.schedules?.business?.sec44AD?.turnoverDigital);
      html += row('44AD Total Turnover', y => y.schedules?.business?.sec44AD?.totalTurnover, { subtotal: true });
      html += row('44AD Presumptive Income', y => y.schedules?.business?.sec44AD?.income, { bold: true });
      html += row('44ADA Gross Receipts', y => y.schedules?.business?.sec44ADA?.grossReceipts);
      html += row('44ADA Presumptive Income', y => y.schedules?.business?.sec44ADA?.income, { bold: true });
    } else if (bizType === 'Company') {
      html += row('Sale of Goods', y => y.schedules?.business?.saleOfGoods);
      html += row('Sale of Services', y => y.schedules?.business?.saleOfServices);
      html += row('Gross Revenue', y => y.schedules?.business?.grossSales, { subtotal: true });
      html += row('Gross Profit', y => y.schedules?.business?.grossProfit, { bold: true });
      html += row('Net Profit (PBT)', y => y.schedules?.business?.netProfit, { bold: true, color: 'var(--green)' });
    } else {
      html += row('Sale of Goods', y => y.schedules?.business?.saleOfGoods);
      html += row('Sale of Services', y => y.schedules?.business?.saleOfServices);
      html += row('Gross Sales/Receipts', y => y.schedules?.business?.grossSales, { subtotal: true });
      html += row('Gross Profit', y => y.schedules?.business?.grossProfit, { bold: true });
      html += row('Professional Receipts', y => y.schedules?.business?.professionalReceipts);
    }
  }

  // Deductions
  if (years.some(y => y.deductions?.total > 0)) {
    html += `<tr><td colspan="${years.length+1}" style="background:var(--glass);font-weight:600;padding:8px 12px">🏷️ Deductions</td></tr>`;
    html += row('80C', y => y.deductions?.sec80C);
    html += row('80D', y => y.deductions?.sec80D);
    html += row('80G', y => y.deductions?.sec80G);
    html += row('80TTA', y => y.deductions?.sec80TTA);
    html += row('80CCD', y => y.deductions?.sec80CCD);
    html += row('Total Deductions', y => y.deductions?.total, { total: true, bold: true, green: true, prefix: '−' });
  }

  // Tax Computation
  html += `<tr><td colspan="${years.length+1}" style="background:var(--glass);font-weight:600;padding:8px 12px">🧮 Tax Computation</td></tr>`;
  html += row('Taxable Income', y => y.totalIncome, { subtotal: true, bold: true, always: true });
  html += row('Tax on Income', y => y.tax?.onIncome, { always: true });
  html += row('Rebate u/s 87A', y => y.tax?.rebate87A, { green: true, prefix: '−' });
  html += row('Surcharge', y => y.tax?.surcharge);
  html += row('Cess', y => y.tax?.cess);
  html += row('Gross Tax Liability', y => y.tax?.totalLiability, { total: true, bold: true, always: true });
  html += row('Interest 234A', y => y.tax?.interest234A, { color: 'var(--red)' });
  html += row('Interest 234B', y => y.tax?.interest234B, { color: 'var(--red)' });
  html += row('Interest 234C', y => y.tax?.interest234C, { color: 'var(--red)' });

  // Taxes Paid
  html += `<tr><td colspan="${years.length+1}" style="background:var(--glass);font-weight:600;padding:8px 12px">💰 Taxes Paid</td></tr>`;
  html += row('TDS', y => y.tax?.tds, { green: true });
  html += row('TCS', y => y.tax?.tcs, { green: true });
  html += row('Advance Tax', y => y.tax?.advanceTax, { green: true });
  html += row('Self Assessment', y => y.tax?.selfAssessment, { green: true });
  html += row('Total Paid', y => y.tax?.totalPaid, { subtotal: true, bold: true, always: true });

  // Balance
  const balRow = years.map(y => {
    const bal = (y.tax?.payable||0) - (y.tax?.refund||0);
    const color = bal > 0 ? 'var(--red)' : bal < 0 ? 'var(--green)' : 'var(--text)';
    const label = bal > 0 ? fmt(bal) : bal < 0 ? '(-)' + fmt(Math.abs(bal)) : '₹0';
    return `<td style="text-align:right;color:${color}"><strong>${label}</strong></td>`;
  }).join('');
  html += `<tr class="comp-total"><td><strong>(+) Tax Payable / (-) Refundable</strong></td>${balRow}</tr>`;

  html += '</tbody></table>';
  $('computationContainer').innerHTML = html;
}

// ===== AIS/TIS Data Tab (from desktop exe — identical) =====
function renderTISData(report) {
  const tis = report.tisData || {};
  const years = Object.keys(tis).sort((a,b) => b.localeCompare(a));
  const container = $('tisdataContainer');
  if (!container) return;

  if (!years.length) {
    container.innerHTML = '<p style="color:var(--text2)">No AIS/TIS data available. Upload AIS/TIS PDF files for third-party reported data.</p>';
    return;
  }

  const catLabels = {
    salary: '💼 Salary', interest: '🏦 Interest', dividend: '📈 Dividend',
    sft: '📑 SFT', tds: '🧾 TDS/TCS', rent: '🏠 Rent',
    sale_of_securities: '📊 Securities', business_income: '💰 Business'
  };

  let html = `<h4 style="margin-bottom:12px">🏛️ AIS/TIS Data — Year-wise Summary</h4>`;
  html += `<table class="data-table"><thead><tr><th>Category</th>`;
  for (const y of years) html += `<th style="text-align:right">F.Y. ${y}</th>`;
  html += `</tr></thead><tbody>`;

  const allCats = new Set();
  for (const y of years) {
    const cats = tis[y]?.categories || tis[y] || {};
    Object.keys(cats).forEach(c => allCats.add(c));
  }

  for (const cat of allCats) {
    const label = catLabels[cat] || cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    html += `<tr><td><strong>${label}</strong></td>`;
    for (const y of years) {
      const cats = tis[y]?.categories || tis[y] || {};
      const val = cats[cat];
      if (val && typeof val === 'object') {
        const amt = val.processed || val.amount || val.value || 0;
        html += `<td style="text-align:right">₹${fmt(amt)}</td>`;
      } else if (val !== undefined) {
        html += `<td style="text-align:right">₹${fmt(val)}</td>`;
      } else {
        html += `<td style="text-align:right;color:var(--text2)">—</td>`;
      }
    }
    html += `</tr>`;
  }

  html += `</tbody></table>`;
  html += `<p style="margin-top:12px;font-size:11px;color:var(--text2)">Data from Income Tax AIS/TIS portal. Values shown are "Processed by System".</p>`;
  container.innerHTML = html;
}

// ===== Mismatch Tab — ITR vs AIS/TIS (from desktop exe — identical) =====
function renderMismatchFromTIS(report) {
  const tis = report.tisData || {};
  const allYears = (report.yearlyITR || []).slice().sort((a,b) => (b.ay||'').localeCompare(a.ay||''));
  const years = deduplicateYears(allYears);
  const container = $('mismatchContainer');
  if (!container) return;

  if (!years.length) {
    container.innerHTML = '<p style="color:var(--text2)">No ITR data for comparison.</p>';
    return;
  }

  let html = '<h4 style="margin-bottom:12px">📊 ITR Filed vs AIS/TIS — Income Comparison</h4>';
  let totalMismatches = 0;

  for (const itr of years) {
    const fy = fyFromAY(itr.ay);
    const tisYear = tis[fy];
    const cats = tisYear?.categories || tisYear || {};

    html += '<div style="background:var(--glass);border-radius:12px;padding:16px;margin-bottom:16px">';
    const ftStr = typeof itr.filingType === 'object' ? JSON.stringify(itr.filingType) : (itr.filingType || '-');
    html += '<h5 style="margin-bottom:10px">AY ' + itr.ay + ' (FY ' + fy + ') — ' + (itr.itrType || itr.detectedType || '') + ' — ' + ftStr + '</h5>';

    if (!Object.keys(cats).length) {
      html += '<p style="color:var(--text2);font-size:12px">⚠️ No AIS/TIS data for FY ' + fy + '. Upload AIS/TIS PDFs for cross-verification.</p></div>';
      continue;
    }

    html += '<table class="data-table"><thead><tr>';
    html += '<th>Income Category</th><th style="text-align:right">ITR Filed (₹)</th>';
    html += '<th style="text-align:right">AIS/TIS (₹)</th><th style="text-align:right">Difference</th><th>Status</th></tr></thead><tbody>';

    const rows = [];
    const n = v => typeof v === 'number' ? v : (typeof v === 'object' && v ? (v.TotIncFromOS || v.total || 0) : (parseFloat(v) || 0));

    // Salary
    const itrSalary = n(itr.income?.salary);
    const tisSalary = cats.salary?.processed || 0;
    if (itrSalary > 0 || tisSalary > 0) rows.push({ cat: '💼 Salary', itr: itrSalary, tis: tisSalary });

    // Interest
    const itrInterest = n(itr.income?.otherSources);
    let tisInterest = 0;
    if (cats.interest) tisInterest += (cats.interest.processed || 0);
    if (cats.interest_savings) tisInterest += (cats.interest_savings.processed || 0);
    if (cats.interest_deposit) tisInterest += (cats.interest_deposit.processed || 0);
    if (cats.interest_other) tisInterest += (cats.interest_other.processed || 0);
    if (itrInterest > 0 || tisInterest > 0) rows.push({ cat: '🏦 Interest/Other Sources', itr: itrInterest, tis: tisInterest });

    // Dividend
    const itrDiv = n(itr.income?.dividend);
    const tisDividend = cats.dividend?.processed || 0;
    if (itrDiv > 0 || tisDividend > 0) rows.push({ cat: '💰 Dividend', itr: itrDiv, tis: tisDividend });

    // House Property
    const itrHP = n(itr.income?.houseProperty);
    const tisRent = cats.rent?.processed || 0;
    if (itrHP !== 0 || tisRent > 0) rows.push({ cat: '🏠 House Property', itr: itrHP, tis: tisRent });

    // Capital Gains
    const itrCG = itr.income?.capitalGains?.total || 0;
    const tisSale = cats.sale_securities?.processed || 0;
    if (itrCG > 0 || tisSale > 0) rows.push({ cat: '📈 Capital Gains / Securities Sale', itr: itrCG, tis: tisSale, note: '⚡ TIS shows gross sale value. Actual gain after deducting purchase cost & losses may differ.' });

    // Purchase of Securities (info only)
    const tisPurchase = cats.purchase_securities?.processed || 0;
    if (tisPurchase > 0) rows.push({ cat: '🛒 Securities Purchase (Info)', itr: '-', tis: tisPurchase, infoOnly: true });

    // Business
    const itrBiz = n(itr.income?.businessProfession);
    const tisBizReceipts = cats.business_receipts?.processed || 0;
    if (itrBiz > 0 || tisBizReceipts > 0) rows.push({ cat: '🏢 Business/Profession', itr: itrBiz, tis: tisBizReceipts, note: tisBizReceipts > 0 ? '⚡ TIS shows gross receipts. ITR shows net profit after expenses.' : '' });

    // GST
    const tisGST = cats.gst_turnover?.processed || 0;
    if (tisGST > 0) rows.push({ cat: '📊 GST Turnover', itr: '-', tis: tisGST, infoOnly: true });
    const tisGSTPurch = cats.gst_purchases?.processed || 0;
    if (tisGSTPurch > 0) rows.push({ cat: '🛍️ GST Purchases', itr: '-', tis: tisGSTPurch, infoOnly: true });

    // SFT
    const tisSFT = cats.sft?.processed || 0;
    if (tisSFT > 0) rows.push({ cat: '📋 SFT Transactions', itr: '-', tis: tisSFT, infoOnly: true });

    // TDS
    const itrTDS = itr.tax?.tds || 0;
    const tisTDS = cats.tds?.processed || cats.tds_deducted?.processed || 0;
    if (itrTDS > 0 || tisTDS > 0) rows.push({ cat: '🧾 TDS', itr: itrTDS, tis: tisTDS });

    for (const row of rows) {
      const itrVal = typeof row.itr === 'number' ? row.itr : 0;
      const tisVal = typeof row.tis === 'number' ? row.tis : 0;
      const diff = tisVal - itrVal;
      const absDiff = Math.abs(diff);
      let status = '', statusColor = 'var(--text2)';

      if (row.infoOnly) { status = 'ℹ️ Info only'; }
      else if (itrVal > 0 && tisVal > 0 && absDiff <= 5000) { status = '✅ Match'; statusColor = 'var(--green)'; }
      else if (itrVal > 0 && tisVal > 0 && absDiff > 5000) { status = diff > 0 ? '⚠️ Under-reported' : '⚠️ Over-reported'; statusColor = absDiff > 50000 ? 'var(--red)' : 'var(--warn)'; totalMismatches++; }
      else if (itrVal > 0 && tisVal === 0) { status = '📝 ITR only'; }
      else if (itrVal === 0 && tisVal > 0) { status = '⚠️ In AIS, not in ITR'; statusColor = 'var(--warn)'; if (tisVal > 5000) totalMismatches++; }
      else { status = '—'; }

      const itrDisplay = typeof row.itr === 'number' ? '₹' + fmt(row.itr) : row.itr;
      const tisDisplay = '₹' + fmt(typeof row.tis === 'number' ? row.tis : row.tis);
      const diffDisplay = row.infoOnly ? '—' : (absDiff > 0 ? (diff > 0 ? '+' : '-') + '₹' + fmt(absDiff) : '₹0');
      const diffColor = diff > 5000 ? 'var(--red)' : diff < -5000 ? 'var(--green)' : 'var(--text2)';
      const noteHtml = row.note ? '<br><span style="font-size:10px;color:var(--text2)">' + row.note + '</span>' : '';

      html += '<tr>';
      html += '<td>' + row.cat + noteHtml + '</td>';
      html += '<td style="text-align:right;font-weight:600">' + itrDisplay + '</td>';
      html += '<td style="text-align:right">' + tisDisplay + '</td>';
      html += '<td style="text-align:right;color:' + diffColor + ';font-weight:600">' + diffDisplay + '</td>';
      html += '<td style="color:' + statusColor + '">' + status + '</td>';
      html += '</tr>';
    }

    // Tax summary row
    const refund = itr.tax?.refund || 0;
    const payable = itr.tax?.payable || 0;
    const bal = payable - refund;
    const balColor = bal > 0 ? 'var(--red)' : bal < 0 ? 'var(--green)' : 'var(--text)';
    const balLabel = bal > 0 ? '(+) Payable: ₹' + fmt(bal) : bal < 0 ? '(-) Refund: ₹' + fmt(Math.abs(bal)) : 'Nil';
    html += '<tr class="comp-total"><td><strong>Taxable Income</strong></td>';
    html += '<td style="text-align:right"><strong>₹' + fmt(itr.totalIncome || 0) + '</strong></td>';
    html += '<td colspan="2">—</td><td style="color:' + balColor + ';font-weight:600">' + balLabel + '</td></tr>';

    html += '</tbody></table></div>';
  }

  if (totalMismatches === 0) {
    html += '<div style="background:var(--glass);padding:12px;border-radius:8px;text-align:center;margin-top:8px"><span style="font-size:20px">✅</span> <strong style="color:var(--green)">No significant mismatches detected</strong></div>';
  } else {
    html += '<div style="background:rgba(231,76,60,0.1);padding:12px;border-radius:8px;text-align:center;margin-top:8px"><span style="font-size:20px">⚠️</span> <strong style="color:var(--red)">' + totalMismatches + ' potential mismatch(es) found</strong><p style="font-size:12px;color:var(--text2);margin-top:4px">Review highlighted items and verify against Form 26AS / AIS portal</p></div>';
  }

  html += '<p style="margin-top:12px;font-size:11px;color:var(--text2)">Note: AIS/TIS amounts are as reported by deductors. Securities sale shows transaction value, not capital gain.</p>';
  container.innerHTML = html;
}

function fyFromAY(ay) {
  const start = parseInt((ay || '').split('-')[0]) - 1;
  const end = (start + 1).toString().slice(-2);
  return start > 2000 ? `${start}-${end}` : null;
}

// ===== Ask AI =====
$('btnAsk').onclick = () => {
  const q = $('askInput').value.trim();
  if (!q) return;
  if (!sessionId) { alert('No analysis data. Run analysis first.'); return; }
  $('askResponse').innerHTML = '<div class="ai-answer" style="color:var(--text2)">⏳ Analyzing...</div>';

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'AI_QUESTION', question: q }));
  } else {
    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, question: q })
    })
    .then(r => r.json())
    .then(data => renderAIAnswer(data.answer || data.error || 'No response'))
    .catch(e => renderAIAnswer('Error: ' + e.message));
  }
  $('askInput').value = '';
};
$('askInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnAsk').click(); });

function renderAIAnswer(answer) {
  $('askResponse').innerHTML = `<div class="ai-answer fade-in">${formatText(answer)}</div>`;
}

function formatText(t) {
  if (!t) return '';
  return t.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n\n/g, '</p><p>').replace(/\n- /g, '<br>• ').replace(/\n\* /g, '<br>• ').replace(/\n(\d+)\.\s/g, '<br><strong>$1.</strong> ').replace(/\n/g, '<br>').replace(/₹([\d,]+)/g, '<span style="color:var(--green);font-weight:600">₹$1</span>');
}

// ===== Downloads =====
$('btnDownloadExcel').onclick = () => {
  if (!sessionId) return;
  showDownloadToast('Excel report');
  window.open(`/api/download/excel/${sessionId}`, '_blank');
};

$('btnDownloadZip').onclick = () => {
  if (!sessionId) return;
  showDownloadToast('ZIP archive');
  window.open(`/api/download/zip/${sessionId}`, '_blank');
};

function showDownloadToast(type) {
  const existing = document.querySelector('.download-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:24px">✅</span>
      <div>
        <strong>${type} downloading...</strong>
        <div style="font-size:11px;color:var(--text2);margin-top:2px">Check your Downloads folder</div>
      </div>
    </div>`;
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--glass);border:1px solid var(--green);color:var(--text);padding:16px 24px;border-radius:12px;z-index:10000;animation:slideUp 0.3s ease;backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,0.3);min-width:280px';
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(20px)'; toast.style.transition = 'all 0.3s ease'; }, 3500);
  setTimeout(() => toast.remove(), 4000);
}

// ===== New Analysis =====
$('btnNewPan').onclick = () => {
  $('reportSection').style.display = 'none';
  $('uploadSection').style.display = 'flex';
  uploadedFiles = [];
  reportData = null;
  aiReportData = null;
  sessionId = null;
  fileList.innerHTML = '';
  $('optionalFields').style.display = 'none';
  btnAnalyze.disabled = true;
  btnAnalyze.innerHTML = '<span>⚡</span> Analyze Now';
  // Reset progress ring
  const ring = $('progressRing');
  if (ring) {
    const circumference = 2 * Math.PI * 52;
    ring.style.strokeDashoffset = circumference;
    ring.style.transition = 'none';
    setTimeout(() => { ring.style.transition = ''; }, 50);
  }
  $('progressPercent').textContent = '0%';
  $('progressLabel').textContent = 'Preparing analysis...';
  $('statusMsg').textContent = '';
  $('statusMsg').className = 'status-msg';
};

// ===== Tabs =====
document.addEventListener('click', e => {
  if (e.target.classList.contains('tab')) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');
    const c = $(`tab-${e.target.dataset.tab}`);
    if (c) c.classList.add('active');
  }
});

// ===== Utilities =====
function fmt(n) { return (n===undefined||n===null||isNaN(n)) ? '0' : Number(n).toLocaleString('en-IN'); }
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
