// app.js — MakeEazy Tax Analyser Online — Frontend
// Upload → WebSocket Progress → Full Report Dashboard

(() => {
  'use strict';

  // ===== STATE =====
  let sessionId = null;
  let ws = null;
  let uploadedFiles = [];
  let reportData = null;
  let aiReportData = null;

  // ===== ELEMENTS =====
  const $ = id => document.getElementById(id);
  const screens = {
    upload: $('screenUpload'),
    processing: $('screenProcessing'),
    report: $('screenReport')
  };

  // ===== SCREEN NAVIGATION =====
  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['json', 'pdf'].includes(ext)) continue;
      if (uploadedFiles.find(f => f.name === file.name)) continue;
      uploadedFiles.push(file);
    }
    renderFileList();
    btnAnalyze.disabled = uploadedFiles.length === 0;
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
      return `<div class="file-item">
        <span class="file-icon">${icon}</span>
        <div class="file-info">
          <div class="file-name">${escHtml(f.name)}</div>
          <div class="file-meta">${size}</div>
        </div>
        <span class="file-type ${typeClass}">${type}</span>
        <button class="file-remove" data-idx="${i}" title="Remove">&times;</button>
      </div>`;
    }).join('');

    fileList.querySelectorAll('.file-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        const idx = parseInt(e.target.dataset.idx);
        uploadedFiles.splice(idx, 1);
        renderFileList();
        btnAnalyze.disabled = uploadedFiles.length === 0;
        if (uploadedFiles.length === 0) $('optionalFields').style.display = 'none';
      });
    });
  }

  // ===== ANALYZE =====
  btnAnalyze.addEventListener('click', startAnalysis);

  async function startAnalysis() {
    if (uploadedFiles.length === 0) return;

    btnAnalyze.disabled = true;
    btnAnalyze.classList.add('loading');
    btnAnalyze.querySelector('.btn-text').textContent = 'Uploading...';

    // Generate session ID
    sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // Upload files
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
      showScreen('processing');
      $('liveLog').innerHTML = '';
      updateProgress(0, 'Connecting...');

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
      btnAnalyze.classList.remove('loading');
      btnAnalyze.querySelector('.btn-text').textContent = 'Analyze Now';
      showScreen('upload');
    }
  }

  // ===== WEBSOCKET =====
  function connectWS(sid) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/?session=${sid}`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch(e) {}
    };

    ws.onclose = () => {
      // Reconnect if analysis still running
      setTimeout(() => {
        if (screens.processing.classList.contains('active')) {
          connectWS(sid);
        }
      }, 2000);
    };

    ws.onerror = () => {};
  }

  function handleWSMessage(msg) {
    switch (msg.type) {
      case 'PROGRESS':
        const pct = Math.round((msg.step / msg.total) * 100);
        updateProgress(pct, msg.message);
        break;

      case 'LOG':
        addLog(msg.message, msg.level);
        break;

      case 'REPORT_DATA':
        reportData = msg.report;
        break;

      case 'AI_REPORT':
        aiReportData = msg.report;
        break;

      case 'COMPLETE':
        reportData = msg.report || reportData;
        aiReportData = msg.aiReport || aiReportData;
        updateProgress(100, 'Complete!');
        setTimeout(() => {
          showScreen('report');
          renderReport();
        }, 800);
        break;

      case 'ERROR':
        addLog('❌ ' + msg.message, 'ERR');
        // If we have partial data, still show report
        if (reportData) {
          setTimeout(() => {
            showScreen('report');
            renderReport();
          }, 2000);
        }
        break;

      case 'AI_ANSWER':
        renderAIAnswer(msg.answer);
        break;
    }
  }

  // ===== PROGRESS =====
  const factsData = [
    "India has over 7.28 crore ITR filers as of FY 2023-24.",
    "The new tax regime became the default from FY 2023-24.",
    "Section 80C allows deductions up to ₹1.5 lakh — the most popular deduction!",
    "LTCG on equity above ₹1.25 lakh is taxed at 12.5% from FY 2024-25.",
    "Standard deduction is ₹75,000 under the new regime (FY 2025-26).",
    "Cess of 4% is charged on income tax + surcharge — it funds education and health.",
    "ITR-1 (Sahaj) is the most commonly filed return — for salaried individuals under ₹50L.",
    "AIS contains third-party reported data — always cross-verify with your ITR.",
    "Tax Saving: NPS u/s 80CCD(1B) gives additional ₹50,000 deduction beyond 80C limit.",
    "Marginal relief ensures your post-tax income never drops due to a small salary increase."
  ];
  let factIdx = 0;

  function updateProgress(pct, label) {
    const ring = $('progressRing');
    const circumference = 2 * Math.PI * 60;
    ring.style.strokeDashoffset = circumference - (pct / 100) * circumference;
    $('progressPercent').textContent = pct + '%';
    $('progressLabel').textContent = label;

    // Rotate facts
    if (pct > 0 && pct < 100) {
      factIdx = (factIdx + 1) % factsData.length;
      $('factText').textContent = factsData[factIdx];
    }
  }

  function addLog(text, level) {
    if (!text) return;
    const el = document.createElement('div');
    if (level) el.className = level.toLowerCase();
    el.textContent = text;
    const log = $('liveLog');
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  // ===== REPORT RENDERING =====
  const fmt = n => {
    if (n === null || n === undefined || isNaN(n)) return '₹0';
    return '₹' + Number(n).toLocaleString('en-IN');
  };
  const pct = (a, b) => b ? ((a / b) * 100).toFixed(1) + '%' : '-';

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderReport() {
    if (!reportData) return;
    const r = reportData;
    const ai = aiReportData || {};
    const years = r.yearlyITR || [];
    const tis = r.tisData || {};

    // AI Hero
    renderAIHero(ai);

    // Profile Cards
    renderProfileCards(r, ai);

    // Compliance & Risk panels
    renderCompliancePanel(ai);
    renderRiskPanel(ai);

    // Tab content
    renderComputationTab(years);
    renderIncomeTab(years);
    renderDeductionsTab(years);
    renderOptimizationTab(ai);
    renderMismatchTab(r, ai);
    renderTISTab(tis);

    // Tab switching
    setupTabs();

    // Download buttons
    setupDownloads();
  }

  function renderAIHero(ai) {
    const hero = $('aiHero');
    const summary = ai.executiveSummary || 'Analysis complete. Review the detailed breakdown below.';
    const model = ai._model || '';
    const profile = ai.taxpayerProfile || {};

    $('aiSummary').innerHTML = escHtml(summary);
    $('aiModel').textContent = model ? `Model: ${model}` : '';

    const metaParts = [];
    if (profile.name) metaParts.push(`👤 ${profile.name}`);
    if (profile.pan) metaParts.push(`PAN: ${profile.pan}`);
    if (profile.category) metaParts.push(profile.category);
    $('aiMeta').textContent = metaParts.join(' • ');
  }

  function renderProfileCards(r, ai) {
    const s = r.summary || {};
    const tp = ai.taxpayerProfile || {};
    const cards = [
      { v: s.downloaded || s.totalReturns || 0, l: 'Returns Analyzed', c: 'var(--blue)' },
      { v: Object.keys(s.itrTypesUsed || {}).join(', ') || '-', l: 'ITR Forms', c: 'var(--purple)' },
      { v: s.latestAY || s.latestFiling || '-', l: 'Latest A.Y.', c: 'var(--green)' },
      { v: s.latestRegime || '-', l: 'Regime', c: 'var(--orange)' },
      { v: s.tisYears || s.yearsWithTIS || 0, l: 'TIS Years', c: 'var(--pink)' },
      { v: tp.riskScore !== undefined ? tp.riskScore + '/100' : '-', l: 'Risk Score', c: tp.riskScore > 60 ? 'var(--red)' : tp.riskScore > 30 ? 'var(--orange)' : 'var(--green)' }
    ];

    $('profileCards').innerHTML = cards.map(c =>
      `<div class="profile-card">
        <div class="card-value" style="color:${c.c}">${escHtml(String(c.v))}</div>
        <div class="card-label">${c.l}</div>
      </div>`
    ).join('');
  }

  function renderCompliancePanel(ai) {
    const panel = $('compliancePanel');
    const cc = ai.complianceCheck || {};
    const checks = cc.checks || [];

    let html = `<h4>✅ Compliance Check${cc.overallStatus ? ' — ' + escHtml(cc.overallStatus) : ''}</h4>`;

    if (checks.length === 0) {
      html += '<div class="info-box info">No compliance data available. Upload ITR JSONs for detailed checks.</div>';
    } else {
      html += checks.map(c => {
        const status = (c.status || '').toLowerCase();
        const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '!';
        const cls = status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'warn';
        return `<div class="check-item">
          <div class="check-icon ${cls}">${icon}</div>
          <div class="check-detail">
            <span class="check-label">${escHtml(c.check || '')}</span>
            ${escHtml(c.detail || '')}
          </div>
        </div>`;
      }).join('');
    }

    panel.innerHTML = html;
  }

  function renderRiskPanel(ai) {
    const panel = $('riskPanel');
    const tp = ai.taxpayerProfile || {};
    const flags = ai.redFlags || [];

    let html = '<h4>🛡️ Risk Assessment</h4>';

    // Risk score meter
    const score = tp.riskScore ?? '-';
    const scoreColor = score > 60 ? 'var(--red)' : score > 30 ? 'var(--orange)' : 'var(--green)';
    html += `<div class="risk-meter">
      <div class="risk-score" style="color:${scoreColor}">${score}</div>
      <div class="risk-label">${tp.summaryLine || 'Risk Score'}</div>
    </div>`;

    // Red flags
    if (flags.length > 0) {
      html += flags.map(f => {
        const sev = (f.severity || 'low').toLowerCase();
        return `<div class="flag-item ${sev}">
          <span class="flag-title">⚠ ${escHtml(f.flag || '')}</span>
          <span class="flag-detail">${escHtml(f.detail || '')}</span>
        </div>`;
      }).join('');
    } else {
      html += '<div class="info-box success">No red flags detected. ✅</div>';
    }

    panel.innerHTML = html;
  }

  // ===== COMPUTATION TABLE =====
  function renderComputationTab(years) {
    if (years.length === 0) {
      $('computationContainer').innerHTML = '<div class="info-box info">No ITR data available. Upload ITR JSON files to see computation details.</div>';
      return;
    }

    const headers = ['A.Y.', 'Form', 'Regime', 'Gross Total', 'Deductions', 'Total Income', 'Tax Paid', 'Refund/Payable', 'Eff. Rate'];
    let html = `<div class="table-wrap"><div class="section-title">📋 Income & Tax Trend</div><table class="data-table"><thead><tr>`;
    html += headers.map(h => `<th>${h}</th>`).join('');
    html += '</tr></thead><tbody>';

    for (const y of years) {
      const tax = y.tax || {};
      const refundOrPay = tax.refund > 0 ? fmt(tax.refund) : tax.payable > 0 ? fmt(tax.payable) : fmt(0);
      const refundClass = tax.refund > 0 ? 'positive' : tax.payable > 0 ? 'negative' : 'muted';
      const regimeColor = (y.regime || '').includes('New') ? 'var(--blue)' : 'var(--orange)';

      html += `<tr>
        <td class="val">${escHtml(y.ay || '')}</td>
        <td><span style="background:rgba(52,211,153,.1);color:var(--green);padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700">${escHtml(y.itrType || y.detectedType || '')}</span></td>
        <td style="color:${regimeColor};font-size:11px">${escHtml(y.regime || '')}</td>
        <td class="val">${fmt(y.grossTotal)}</td>
        <td style="color:var(--purple)">${fmt(y.deductions?.total)}</td>
        <td class="val">${fmt(y.totalIncome)}</td>
        <td>${fmt(tax.totalPaid)}</td>
        <td class="${refundClass}">${refundOrPay}</td>
        <td class="muted">${pct(tax.totalPaid, y.totalIncome)}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    $('computationContainer').innerHTML = html;
  }

  // ===== INCOME TAB =====
  function renderIncomeTab(years) {
    if (years.length === 0) {
      $('incomeContainer').innerHTML = '<div class="info-box info">No ITR data available.</div>';
      return;
    }

    const headers = ['A.Y.', 'Salary', 'House Property', 'Business/Prof', 'Capital Gains', 'Other Sources', 'Exempt Income'];
    let html = `<div class="table-wrap"><div class="section-title">📈 Income Sources Breakdown</div><table class="data-table"><thead><tr>`;
    html += headers.map(h => `<th>${h}</th>`).join('');
    html += '</tr></thead><tbody>';

    for (const y of years) {
      const inc = y.income || {};
      const cg = inc.capitalGains || {};
      html += `<tr>
        <td class="val">${escHtml(y.ay || '')}</td>
        <td style="color:${inc.salary ? 'var(--text)' : 'var(--text3)'}">${fmt(inc.salary)}</td>
        <td style="color:${inc.houseProperty ? 'var(--text)' : 'var(--text3)'}">${fmt(inc.houseProperty)}</td>
        <td style="color:${inc.businessProfession ? 'var(--text)' : 'var(--text3)'}">${fmt(inc.businessProfession)}</td>
        <td style="color:${cg.total ? 'var(--text)' : 'var(--text3)'}">${fmt(cg.total || (cg.stcg||0)+(cg.ltcg||0))}</td>
        <td style="color:${inc.otherSources ? 'var(--text)' : 'var(--text3)'}">${fmt(inc.otherSources)}</td>
        <td style="color:${inc.exemptIncome ? 'var(--green)' : 'var(--text3)'}">${fmt(inc.exemptIncome)}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    $('incomeContainer').innerHTML = html;
  }

  // ===== DEDUCTIONS TAB =====
  function renderDeductionsTab(years) {
    if (years.length === 0) {
      $('deductionsContainer').innerHTML = '<div class="info-box info">No ITR data available.</div>';
      return;
    }

    const headers = ['A.Y.', '80C', '80D', '80G', '80TTA/TTB', '80CCD', 'Total'];
    let html = `<div class="table-wrap"><div class="section-title">🏷️ Deductions (Chapter VI-A)</div><table class="data-table"><thead><tr>`;
    html += headers.map(h => `<th>${h}</th>`).join('');
    html += '</tr></thead><tbody>';

    for (const y of years) {
      const d = y.deductions || {};
      html += `<tr>
        <td class="val">${escHtml(y.ay || '')}</td>
        <td style="color:var(--purple)">${fmt(d.sec80C)}</td>
        <td style="color:var(--purple)">${fmt(d.sec80D)}</td>
        <td style="color:var(--purple)">${fmt(d.sec80G)}</td>
        <td style="color:var(--purple)">${fmt(d.sec80TTA)}</td>
        <td style="color:var(--purple)">${fmt(d.sec80CCD)}</td>
        <td class="val">${fmt(d.total)}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';

    // Tax Computation Detail
    const taxHeaders = ['A.Y.', 'Tax on Income', 'Rebate 87A', 'Surcharge', 'Cess', 'Total Liability', 'TDS', 'Adv. Tax', 'Self Assess.', 'Total Paid', 'Refund/Pay'];
    html += `<div class="table-wrap"><div class="section-title">🧮 Tax Computation Detail</div><table class="data-table"><thead><tr>`;
    html += taxHeaders.map(h => `<th>${h}</th>`).join('');
    html += '</tr></thead><tbody>';

    for (const y of years) {
      const t = y.tax || {};
      const bal = t.refund > 0 ? fmt(t.refund) : t.payable > 0 ? fmt(t.payable) : fmt(0);
      const balClass = t.refund > 0 ? 'positive' : t.payable > 0 ? 'negative' : 'muted';
      html += `<tr>
        <td class="val">${escHtml(y.ay || '')}</td>
        <td>${fmt(t.onIncome)}</td>
        <td style="color:var(--green)">${fmt(t.rebate87A)}</td>
        <td>${fmt(t.surcharge)}</td>
        <td>${fmt(t.cess)}</td>
        <td style="color:var(--red)">${fmt(t.totalLiability || t.netLiability)}</td>
        <td style="color:var(--blue)">${fmt(t.tds)}</td>
        <td style="color:var(--blue)">${fmt(t.advanceTax)}</td>
        <td style="color:var(--blue)">${fmt(t.selfAssessment)}</td>
        <td class="val">${fmt(t.totalPaid)}</td>
        <td class="${balClass}" style="font-weight:700">${bal}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    $('deductionsContainer').innerHTML = html;
  }

  // ===== OPTIMIZATION TAB =====
  function renderOptimizationTab(ai) {
    const opt = ai.taxOptimization || {};
    const recs = opt.recommendations || [];

    let html = '';

    // Regime comparison
    if (opt.currentRegime || opt.optimalRegime) {
      html += `<div class="opt-regime">
        <div class="regime-item">
          <span class="regime-label">Current Regime</span>
          <span class="regime-value">${escHtml(opt.currentRegime || '-')}</span>
        </div>
        <div class="regime-arrow">→</div>
        <div class="regime-item">
          <span class="regime-label">Optimal Regime</span>
          <span class="regime-value">${escHtml(opt.optimalRegime || '-')}</span>
        </div>
        ${opt.potentialSavings ? `<div class="regime-item">
          <span class="regime-label">Potential Savings</span>
          <span class="regime-value savings">${fmt(opt.potentialSavings)}</span>
        </div>` : ''}
      </div>`;
    }

    if (recs.length === 0) {
      html += '<div class="info-box info">No specific optimization recommendations available. Upload more data for detailed suggestions.</div>';
    } else {
      html += recs.map(r => `<div class="opt-card">
        <div class="opt-header">
          <span class="opt-title">${escHtml(r.title || '')}</span>
          <span class="opt-priority ${(r.priority || 'low').toLowerCase()}">${escHtml(r.priority || '')}</span>
        </div>
        <div class="opt-desc">${escHtml(r.description || '')}</div>
      </div>`).join('');
    }

    $('optimizationContainer').innerHTML = html;
  }

  // ===== MISMATCH TAB =====
  function renderMismatchTab(r, ai) {
    const cv = r.crossVerification || [];
    const aiMismatches = ai.aisVsItrMismatch || [];
    const hasMismatches = cv.some(c => c.mismatches && c.mismatches.length > 0) || aiMismatches.length > 0;

    let html = '';

    if (!hasMismatches) {
      html = cv.some(c => c.hasTIS)
        ? '<div class="no-mismatch">✅ No discrepancies found between ITR declared income and TIS reported data.</div>'
        : '<div class="info-box info">No TIS data available for cross-verification. Upload AIS/TIS PDFs to check for mismatches.</div>';
    } else {
      // From analyzer cross-verification
      for (const c of cv) {
        if (!c.mismatches || c.mismatches.length === 0) continue;
        html += `<div class="mismatch-item">
          <div class="mismatch-ay">A.Y. ${escHtml(c.ay || '')}</div>
          ${c.mismatches.map(m => `<span class="mismatch-detail">
            ${escHtml(m.field)}: ITR ${fmt(m.itr)} vs TIS ${fmt(m.tis)}
          </span>`).join('')}
        </div>`;
      }

      // From AI analysis
      for (const m of aiMismatches) {
        html += `<div class="mismatch-item">
          <div class="mismatch-ay">${escHtml(m.field || m.category || '')}</div>
          <span class="mismatch-detail">${escHtml(m.detail || m.description || JSON.stringify(m))}</span>
        </div>`;
      }
    }

    $('mismatchContainer').innerHTML = html;
  }

  // ===== TIS DATA TAB =====
  function renderTISTab(tis) {
    if (!tis || Object.keys(tis).length === 0) {
      $('tisdataContainer').innerHTML = '<div class="info-box info">No AIS/TIS data available. Upload AIS or TIS PDF files to see detailed third-party reported data.</div>';
      return;
    }

    let html = '';
    for (const [fy, data] of Object.entries(tis)) {
      const cats = data.categories || {};
      if (Object.keys(cats).length === 0) continue;

      html += `<div class="tis-year">
        <div class="tis-year-header"><span>📋</span> F.Y. ${escHtml(fy)}</div>
        <div class="tis-cats">
          ${Object.entries(cats).map(([k, v]) => `<div class="tis-cat">
            <div class="cat-name">${escHtml(v.name || k.replace(/_/g, ' '))}</div>
            <div class="cat-value">${fmt(v.processed || 0)}</div>
          </div>`).join('')}
        </div>
      </div>`;
    }

    $('tisdataContainer').innerHTML = html || '<div class="info-box info">No structured data extracted from PDFs.</div>';
  }

  // ===== TAB SWITCHING =====
  function setupTabs() {
    const tabs = document.querySelectorAll('#reportTabs .tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
        const target = document.getElementById('tab-' + tab.dataset.tab);
        if (target) target.classList.add('active');
      });
    });
  }

  // ===== DOWNLOADS =====
  function setupDownloads() {
    $('btnDownloadExcel').addEventListener('click', () => {
      if (!sessionId) return;
      window.open(`/api/download/excel/${sessionId}`, '_blank');
    });

    $('btnDownloadZip').addEventListener('click', () => {
      if (!sessionId) return;
      window.open(`/api/download/zip/${sessionId}`, '_blank');
    });

    $('btnNewAnalysis').addEventListener('click', () => {
      uploadedFiles = [];
      reportData = null;
      aiReportData = null;
      sessionId = null;
      fileList.innerHTML = '';
      $('optionalFields').style.display = 'none';
      btnAnalyze.disabled = true;
      btnAnalyze.classList.remove('loading');
      btnAnalyze.querySelector('.btn-text').textContent = 'Analyze Now';
      showScreen('upload');
    });
  }

  // ===== AI CHAT =====
  $('btnAsk').addEventListener('click', askAI);
  $('askInput').addEventListener('keypress', e => { if (e.key === 'Enter') askAI(); });

  async function askAI() {
    const input = $('askInput');
    const question = input.value.trim();
    if (!question) return;
    if (!sessionId) { alert('No analysis data. Run analysis first.'); return; }

    const responseEl = $('askResponse');
    responseEl.innerHTML = '<div class="spinner"></div> Thinking...';

    // Try WebSocket first
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'AI_QUESTION', question }));
    } else {
      // HTTP fallback
      try {
        const resp = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, question })
        });
        const data = await resp.json();
        renderAIAnswer(data.answer || data.error || 'No response');
      } catch(e) {
        renderAIAnswer('Error: ' + e.message);
      }
    }

    input.value = '';
  }

  function renderAIAnswer(answer) {
    const responseEl = $('askResponse');
    // Simple markdown-like rendering
    let formatted = escHtml(answer || '')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    responseEl.innerHTML = `<div class="ai-answer">${formatted}</div>`;
  }

  // ===== INIT =====
  showScreen('upload');
  
  // Add SVG gradient for progress ring
  const svg = document.querySelector('.progress-ring');
  if (svg) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3b82f6"/>
      <stop offset="100%" style="stop-color:#a78bfa"/>
    </linearGradient>`;
    svg.prepend(defs);
    const ringFill = svg.querySelector('.ring-fill');
    if (ringFill) ringFill.setAttribute('stroke', 'url(#grad)');
  }

})();
