// lib/excel-report.js — Generate formatted Excel report from ITR analysis data
const ExcelJS = require('exceljs');

// Currency formatter
const fmt = (v) => v != null && v !== 0 ? Number(v) : 0;

async function generateExcelReport(report, aiReport) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MakeEazy Tax Profiler';
  wb.created = new Date();

  const years = (report.yearlyITR || []).sort((a, b) => (a.ay || '').localeCompare(b.ay || ''));

  // === Color constants ===
  const HEADER_BG = 'FF1A237E'; // Deep indigo
  const HEADER_FG = 'FFFFFFFF';
  const SECTION_BG = 'FFE8EAF6'; // Light indigo
  const ALT_ROW_BG = 'FFF5F5F5';
  const GREEN_BG = 'FFE8F5E9';
  const RED_BG = 'FFFFEBEE';
  const BLUE_BG = 'FFE3F2FD';
  const ORANGE_BG = 'FFFFF3E0';
  const BORDER_STYLE = { style: 'thin', color: { argb: 'FFD0D0D0' } };
  const BORDER = { top: BORDER_STYLE, bottom: BORDER_STYLE, left: BORDER_STYLE, right: BORDER_STYLE };

  const numFmt = '#,##0';
  const pctFmt = '0.0%';

  function styleHeader(row) {
    row.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
      c.font = { color: { argb: HEADER_FG }, bold: true, size: 11 };
      c.border = BORDER;
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    row.height = 28;
  }

  function styleSectionRow(row, bg = SECTION_BG) {
    row.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      c.font = { bold: true, size: 11 };
      c.border = BORDER;
    });
  }

  function styleDataRow(row, isAlt = false) {
    row.eachCell(c => {
      c.border = BORDER;
      c.alignment = { vertical: 'middle' };
      if (isAlt) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ALT_ROW_BG } };
    });
  }

  // ===================================================================
  // SHEET 1: SUMMARY
  // ===================================================================
  const sumSheet = wb.addWorksheet('Summary', { properties: { tabColor: { argb: '1A237E' } } });
  sumSheet.columns = [
    { header: '', key: 'label', width: 32 },
    { header: '', key: 'value', width: 45 }
  ];

  // Title
  sumSheet.mergeCells('A1:B1');
  const titleRow = sumSheet.getRow(1);
  titleRow.getCell(1).value = 'MakeEazy Tax Profiler — Summary Report';
  titleRow.getCell(1).font = { size: 16, bold: true, color: { argb: 'FF1A237E' } };
  titleRow.getCell(1).alignment = { horizontal: 'center' };
  titleRow.height = 35;

  // Meta info
  const meta = report.meta || {};
  const summary = report.summary || {};
  const addPair = (label, value, bg) => {
    const r = sumSheet.addRow({ label, value: value || '-' });
    r.eachCell(c => { c.border = BORDER; c.alignment = { vertical: 'middle' }; });
    if (bg) r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; });
    return r;
  };

  sumSheet.addRow({});
  const secRow = sumSheet.addRow({ label: '👤 Taxpayer Profile', value: '' });
  styleSectionRow(secRow, BLUE_BG);

  addPair('PAN', meta.pan);
  addPair('Name', meta.name);
  addPair('Date of Birth', meta.dob);
  addPair('Generated', new Date(meta.generatedAt).toLocaleString('en-IN'));

  sumSheet.addRow({});
  const filingRow = sumSheet.addRow({ label: '📋 Filing Summary', value: '' });
  styleSectionRow(filingRow, GREEN_BG);

  addPair('Total Returns Found', String(summary.totalReturns || 0));
  addPair('Successfully Downloaded', String(summary.downloaded || 0));
  addPair('ITR Types Used', Object.entries(summary.itrTypesUsed || {}).map(([k,v]) => `${k}: ${v}`).join(', '));
  addPair('Latest A.Y.', summary.latestAY);
  addPair('Latest Regime', summary.latestRegime);
  addPair('Latest Total Income', `₹${fmt(summary.latestIncome).toLocaleString('en-IN')}`);
  addPair('Latest Tax Liability', `₹${fmt(summary.latestTax).toLocaleString('en-IN')}`);

  // AI insights if available
  if (aiReport?.taxpayerProfile) {
    const tp = aiReport.taxpayerProfile;
    sumSheet.addRow({});
    const aiRow = sumSheet.addRow({ label: '🤖 AI Assessment', value: '' });
    styleSectionRow(aiRow, ORANGE_BG);
    addPair('Risk Score', `${tp.riskScore || '-'}/100`);
    addPair('Tax Efficiency', tp.taxEfficiency || '-');
    addPair('Compliance Rating', tp.complianceRating || '-');
    addPair('Primary Income Source', tp.primaryIncomeSource || '-');
    if (tp.flags?.length) addPair('Flags', tp.flags.join(', '));
  }

  // ===================================================================
  // SHEET 2: COMPUTATION (side-by-side all years)
  // ===================================================================
  const compSheet = wb.addWorksheet('Computation', { properties: { tabColor: { argb: '4CAF50' } } });

  // Header row: Particulars | AY1 | AY2 | ...
  const compHeaders = ['Particulars', ...years.map(y => `A.Y. ${y.ay}\n${y.detectedType || y.itrType}`)];
  const compHdrRow = compSheet.addRow(compHeaders);
  styleHeader(compHdrRow);
  compSheet.getColumn(1).width = 30;
  years.forEach((_, i) => { compSheet.getColumn(i + 2).width = 18; });

  const addCompRow = (label, getter, opts = {}) => {
    const values = years.map(y => fmt(getter(y)));
    if (!opts.always && values.every(v => v === 0)) return;
    const row = compSheet.addRow([label, ...values]);
    row.getCell(1).font = { bold: !!opts.bold };
    for (let i = 2; i <= years.length + 1; i++) {
      row.getCell(i).numFmt = numFmt;
      row.getCell(i).alignment = { horizontal: 'right' };
    }
    styleDataRow(row, opts.alt);
    if (opts.bold) row.eachCell(c => { c.font = { ...c.font, bold: true }; });
    if (opts.section) styleSectionRow(row, opts.sectionBg || SECTION_BG);
    if (opts.green) years.forEach((_, i) => {
      const v = values[i];
      if (v > 0) row.getCell(i + 2).font = { color: { argb: 'FF2E7D32' }, bold: true };
    });
    if (opts.red) years.forEach((_, i) => {
      const v = values[i];
      if (v > 0) row.getCell(i + 2).font = { color: { argb: 'FFC62828' }, bold: true };
    });
    return row;
  };

  // Section: Basic Info
  const infoRow = compSheet.addRow(['Regime', ...years.map(y => y.regime || '-')]);
  styleSectionRow(infoRow, BLUE_BG);
  const ftRow = compSheet.addRow(['Filing Type', ...years.map(y => y.filingType || '-')]);
  styleDataRow(ftRow);

  // Section: Income
  compSheet.addRow([]);
  addCompRow('📊 INCOME HEADS', () => '', { section: true, sectionBg: BLUE_BG });
  addCompRow('Income from Salary', y => y.income?.salary);
  addCompRow('House Property', y => y.income?.houseProperty);
  addCompRow('Business/Profession', y => y.income?.businessProfession);
  addCompRow('Capital Gains — STCG', y => y.income?.capitalGains?.stcg);
  addCompRow('Capital Gains — LTCG', y => y.income?.capitalGains?.ltcg);
  addCompRow('Other Sources', y => y.income?.otherSources);
  addCompRow('Exempt Income', y => y.income?.exemptIncome);
  addCompRow('Agricultural Income', y => y.income?.agriculturalIncome);
  addCompRow('Gross Total Income', y => y.grossTotal, { bold: true, always: true });

  // Section: Deductions
  compSheet.addRow([]);
  addCompRow('🏷️ DEDUCTIONS', () => '', { section: true, sectionBg: GREEN_BG });
  addCompRow('80C (Investments)', y => y.deductions?.sec80C);
  addCompRow('80D (Medical Insurance)', y => y.deductions?.sec80D);
  addCompRow('80G (Donations)', y => y.deductions?.sec80G);
  addCompRow('80TTA (Savings Interest)', y => y.deductions?.sec80TTA);
  addCompRow('80CCD (NPS)', y => y.deductions?.sec80CCD);
  addCompRow('Total Deductions', y => y.deductions?.total, { bold: true, green: true });

  // Section: Taxable Income
  compSheet.addRow([]);
  addCompRow('💰 TAX COMPUTATION', () => '', { section: true, sectionBg: ORANGE_BG });
  addCompRow('Total Taxable Income', y => y.totalIncome, { bold: true, always: true });
  addCompRow('Tax on Income', y => y.tax?.onIncome);
  addCompRow('Rebate u/s 87A', y => y.tax?.rebate87A, { green: true });
  addCompRow('Surcharge', y => y.tax?.surcharge);
  addCompRow('Health & Edu Cess', y => y.tax?.cess);
  addCompRow('Total Tax Liability', y => y.tax?.totalLiability, { bold: true });
  addCompRow('Interest 234A/B/C', y => (fmt(y.tax?.interest234A) + fmt(y.tax?.interest234B) + fmt(y.tax?.interest234C)), { red: true });
  addCompRow('Late Filing Fee', y => y.tax?.lateFee, { red: true });

  // Section: Tax Paid
  compSheet.addRow([]);
  addCompRow('✅ TAX PAID / CREDITS', () => '', { section: true, sectionBg: GREEN_BG });
  addCompRow('TDS', y => y.tax?.tds, { green: true });
  addCompRow('TCS', y => y.tax?.tcs);
  addCompRow('Advance Tax', y => y.tax?.advanceTax);
  addCompRow('Self Assessment Tax', y => y.tax?.selfAssessment);
  addCompRow('Total Tax Paid', y => y.tax?.totalPaid, { bold: true, green: true, always: true });

  // Section: Result
  compSheet.addRow([]);
  addCompRow('📊 RESULT', () => '', { section: true, sectionBg: 'FFFFCCBC' });
  addCompRow('(+) Tax Payable', y => y.tax?.payable, { bold: true, red: true });
  addCompRow('(-) Refund Due', y => y.tax?.refund, { bold: true, green: true });

  // ===================================================================
  // SHEET 3: INCOME TREND
  // ===================================================================
  const trendSheet = wb.addWorksheet('Income Trend', { properties: { tabColor: { argb: 'FF9800' } } });
  const trendHeaders = ['Metric', ...years.map(y => `A.Y. ${y.ay}`)];
  if (years.length > 1) trendHeaders.push('Growth %');
  const tHdr = trendSheet.addRow(trendHeaders);
  styleHeader(tHdr);
  trendSheet.getColumn(1).width = 28;
  years.forEach((_, i) => { trendSheet.getColumn(i + 2).width = 16; });

  const addTrendRow = (label, getter) => {
    const vals = years.map(y => fmt(getter(y)));
    const rowData = [label, ...vals];
    if (years.length > 1) {
      const first = vals[0] || 1;
      const last = vals[vals.length - 1];
      const growth = first !== 0 ? ((last - first) / Math.abs(first)) : 0;
      rowData.push(growth);
    }
    const r = trendSheet.addRow(rowData);
    for (let i = 2; i <= years.length + 1; i++) r.getCell(i).numFmt = numFmt;
    if (years.length > 1) {
      const gc = r.getCell(years.length + 2);
      gc.numFmt = pctFmt;
      gc.font = { bold: true, color: { argb: gc.value >= 0 ? 'FF2E7D32' : 'FFC62828' } };
    }
    styleDataRow(r);
    return r;
  };

  addTrendRow('Gross Total Income', y => y.grossTotal);
  addTrendRow('Total Taxable Income', y => y.totalIncome);
  addTrendRow('Income from Salary', y => y.income?.salary);
  addTrendRow('Business/Profession', y => y.income?.businessProfession);
  addTrendRow('Capital Gains', y => (fmt(y.income?.capitalGains?.stcg) + fmt(y.income?.capitalGains?.ltcg)));
  addTrendRow('Other Sources', y => y.income?.otherSources);
  addTrendRow('Total Deductions', y => y.deductions?.total);
  addTrendRow('Tax on Income', y => y.tax?.onIncome);
  addTrendRow('TDS', y => y.tax?.tds);
  addTrendRow('Refund', y => y.tax?.refund);
  addTrendRow('Tax Payable', y => y.tax?.payable);

  // ===================================================================
  // SHEET 4: AIS / TIS DATA
  // ===================================================================
  if (report.tisData && Object.keys(report.tisData).length > 0) {
    const aisSheet = wb.addWorksheet('AIS-TIS Data', { properties: { tabColor: { argb: '009688' } } });
    const aisFYs = Object.keys(report.tisData).sort();
    const aisHdr = aisSheet.addRow(['Category', ...aisFYs.map(fy => `F.Y. ${fy} (Processed)`), ...aisFYs.map(fy => `F.Y. ${fy} (Reported)`)]);
    styleHeader(aisHdr);
    aisSheet.getColumn(1).width = 28;

    // Collect all categories
    const allCats = new Set();
    for (const data of Object.values(report.tisData)) {
      if (data.categories) Object.keys(data.categories).forEach(k => allCats.add(k));
    }

    for (const cat of allCats) {
      const processed = aisFYs.map(fy => fmt(report.tisData[fy]?.categories?.[cat]?.processed));
      const reported = aisFYs.map(fy => fmt(report.tisData[fy]?.categories?.[cat]?.reported));
      const r = aisSheet.addRow([cat, ...processed, ...reported]);
      for (let i = 2; i <= r.cellCount; i++) r.getCell(i).numFmt = numFmt;
      styleDataRow(r);
    }
  }

  // ===================================================================
  // SHEET 5: CROSS VERIFICATION / MISMATCHES
  // ===================================================================
  if (report.crossVerification?.some(v => v.mismatches?.length > 0)) {
    const mmSheet = wb.addWorksheet('Mismatches', { properties: { tabColor: { argb: 'F44336' } } });
    const mmHdr = mmSheet.addRow(['A.Y.', 'F.Y.', 'Field', 'ITR Value', 'AIS/TIS Value', 'Difference']);
    styleHeader(mmHdr);
    mmSheet.getColumn(1).width = 14;
    mmSheet.getColumn(2).width = 14;
    mmSheet.getColumn(3).width = 20;
    mmSheet.getColumn(4).width = 18;
    mmSheet.getColumn(5).width = 18;
    mmSheet.getColumn(6).width = 18;

    for (const v of report.crossVerification) {
      for (const m of (v.mismatches || [])) {
        const diff = Math.abs(fmt(m.itr) - fmt(m.tis));
        const r = mmSheet.addRow([v.ay, v.fy, m.field, fmt(m.itr), fmt(m.tis), diff]);
        for (let i = 4; i <= 6; i++) r.getCell(i).numFmt = numFmt;
        styleDataRow(r);
        r.getCell(6).font = { color: { argb: 'FFC62828' }, bold: true };
      }
    }
  }

  // ===================================================================
  // SHEET 6: AI ANALYSIS (if available)
  // ===================================================================
  if (aiReport) {
    const aiSheet = wb.addWorksheet('AI Analysis', { properties: { tabColor: { argb: '9C27B0' } } });
    aiSheet.columns = [
      { header: 'Section', key: 'section', width: 30 },
      { header: 'Detail', key: 'detail', width: 70 }
    ];
    const aiHdr = aiSheet.getRow(1);
    styleHeader(aiHdr);

    const addAIRow = (section, detail, bg) => {
      const r = aiSheet.addRow({ section, detail: String(detail || '-') });
      r.getCell(2).alignment = { wrapText: true };
      styleDataRow(r);
      if (bg) r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; });
    };

    // Executive Summary
    if (aiReport.executiveSummary) {
      addAIRow('📋 Executive Summary', '', BLUE_BG);
      const es = aiReport.executiveSummary;
      if (typeof es === 'string') {
        addAIRow('  Summary', es);
      } else {
        if (es.keyFindings?.length) es.keyFindings.forEach((f, i) => addAIRow(`  Finding ${i + 1}`, f));
        if (es.overallAssessment) addAIRow('  Overall', es.overallAssessment);
        // Stringify any other fields
        for (const [k, v] of Object.entries(es)) {
          if (!['keyFindings', 'overallAssessment'].includes(k) && v) {
            addAIRow(`  ${k}`, typeof v === 'string' ? v : JSON.stringify(v));
          }
        }
      }
    }

    // Taxpayer Profile
    if (aiReport.taxpayerProfile) {
      addAIRow('👤 Taxpayer Profile', '', BLUE_BG);
      const tp = aiReport.taxpayerProfile;
      if (tp.name) addAIRow('  Name', tp.name);
      if (tp.category) addAIRow('  Category', tp.category);
      if (tp.riskScore != null) addAIRow('  Risk Score', `${tp.riskScore}/100`);
      if (tp.taxEfficiency) addAIRow('  Tax Efficiency', tp.taxEfficiency);
      if (tp.complianceRating) addAIRow('  Compliance', tp.complianceRating);
      if (tp.primaryIncomeSource) addAIRow('  Primary Income', tp.primaryIncomeSource);
      if (tp.summaryLine) addAIRow('  Summary', tp.summaryLine);
      if (tp.flags?.length) addAIRow('  Flags', tp.flags.join(', '));
    }

    // Tax Optimization / Regime
    const taxOpt = aiReport.taxOptimization;
    if (taxOpt) {
      addAIRow('💡 Tax Optimization', '', ORANGE_BG);
      if (taxOpt.currentRegime) addAIRow('  Current Regime', taxOpt.currentRegime);
      if (taxOpt.optimalRegime) addAIRow('  Optimal Regime', taxOpt.optimalRegime);
      if (taxOpt.potentialSavings != null) addAIRow('  Potential Savings', `₹${fmt(taxOpt.potentialSavings).toLocaleString('en-IN')}`);
      if (taxOpt.recommendations?.length) {
        taxOpt.recommendations.forEach((tip, i) => {
          const txt = typeof tip === 'string' ? tip : `${tip.title || tip.action || ''}: ${tip.detail || tip.description || tip.impact || ''}`;
          addAIRow(`  Tip ${i + 1}`, txt);
        });
      }
    }

    // Income Analysis
    if (aiReport.incomeAnalysis) {
      addAIRow('📈 Income Analysis', '', GREEN_BG);
      const ia = aiReport.incomeAnalysis;
      
      // Handle yearWise array (most common format)
      if (ia.yearWise && Array.isArray(ia.yearWise)) {
        addAIRow('  A.Y.', 'ITR Type | Regime | Gross Income | Taxable Income | Tax Paid | Effective Rate');
        ia.yearWise.forEach(y => {
          const parts = [
            y.itrType || '-',
            y.regime || '-',
            `₹${fmt(y.grossIncome).toLocaleString('en-IN')}`,
            `₹${fmt(y.taxableIncome).toLocaleString('en-IN')}`,
            `₹${fmt(y.taxPaid).toLocaleString('en-IN')}`,
            y.effectiveTaxRate || '-'
          ];
          addAIRow(`  ${y.ay || '-'}`, parts.join(' | '));
        });
      } else if (typeof ia === 'string') {
        addAIRow('  Analysis', ia);
      } else if (Array.isArray(ia)) {
        ia.forEach((item, i) => {
          if (typeof item === 'string') addAIRow(`  ${i + 1}`, item);
          else if (item.ay || item.year) {
            const parts = [item.itrType, item.regime, `₹${fmt(item.grossIncome).toLocaleString('en-IN')}`, `₹${fmt(item.taxPaid).toLocaleString('en-IN')}`].filter(Boolean);
            addAIRow(`  ${item.ay || item.year}`, parts.join(' | '));
          }
          else addAIRow(`  ${i + 1}`, Object.entries(item).map(([k,v]) => `${k}: ${v}`).join(', '));
        });
      } else {
        // Object with named keys — show each as readable row
        for (const [k, v] of Object.entries(ia)) {
          if (k === 'yearWise') continue;
          if (typeof v === 'string' || typeof v === 'number') addAIRow(`  ${k}`, String(v));
          else if (Array.isArray(v)) addAIRow(`  ${k}`, v.map(i => typeof i === 'string' ? i : JSON.stringify(i)).join('; '));
          else addAIRow(`  ${k}`, Object.entries(v).map(([sk,sv]) => `${sk}: ${sv}`).join(', '));
        }
      }
    }

    // Compliance Checks
    const cc = aiReport.complianceCheck;
    if (cc) {
      addAIRow('✅ Compliance', '', GREEN_BG);
      if (cc.overallStatus) addAIRow('  Overall Status', cc.overallStatus);
      if (cc.checks?.length) {
        cc.checks.forEach((item, i) => {
          const txt = `${item.check || item.item || ''}: ${item.status || ''} — ${item.detail || item.remarks || item.description || ''}`;
          addAIRow(`  Check ${i + 1}`, txt.trim());
        });
      }
      // If complianceCheck is an array (alternate format)
      if (Array.isArray(cc)) {
        cc.forEach((item, i) => {
          const txt = typeof item === 'string' ? item : `${item.issue || item.category || ''}: ${item.detail || item.status || ''}`;
          addAIRow(`  Item ${i + 1}`, txt);
        });
      }
    }

    // Red Flags
    const flags = aiReport.redFlags || aiReport.riskAreas || [];
    if (flags.length) {
      addAIRow('🚨 Red Flags / Risks', '', RED_BG);
      flags.forEach((f, i) => {
        const txt = typeof f === 'string' ? f : `${f.flag || f.title || f.area || ''}: ${f.detail || f.description || ''} [${f.severity || ''}]`;
        addAIRow(`  Flag ${i + 1}`, txt.trim());
      });
    }
  }

  return wb;
}

module.exports = { generateExcelReport };
