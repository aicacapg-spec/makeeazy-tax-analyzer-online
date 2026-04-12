// lib/pdf-analyzer.js — Unlock and analyze AIS/TIS PDFs
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const fs = require('fs');
const path = require('path');

async function extractPdfText(filePath, password) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const opts = { data };
  if (password) opts.password = password;
  
  const doc = await pdfjsLib.getDocument(opts).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(' ') + '\n';
  }
  return { text: fullText, pages: doc.numPages };
}

function normalizeSpaces(text) {
  // AIS PDFs have weird spacing like "S a l a r y" or "Salary" with extra spaces
  return text.replace(/\s+/g, ' ').trim();
}

function parseAISPdfText(text, isTypeAIS) {
  const result = { categories: {}, sections: [], rawSummary: '' };
  const norm = normalizeSpaces(text);

  // ===== Extract structured sections =====
  
  // TDS/TCS Section
  const tdsMatch = norm.match(/Part\s*B1[^]*?(?:Part\s*B2|$)/i);
  if (tdsMatch) {
    const tdsText = tdsMatch[0];
    if (!/No\s+Transactions?\s+Present/i.test(tdsText)) {
      const amts = [...tdsText.matchAll(/(?:TOTAL|Amount)[^\d]*?([\d,]+(?:\.\d+)?)/gi)];
      if (amts.length > 0) {
        const total = amts.reduce((s, m) => s + parseFloat(m[1].replace(/,/g, '')), 0);
        if (total > 0) result.categories.tds_tcs = { name: 'TDS/TCS', processed: total, reported: 0 };
      }
    }
  }

  // SFT Section (Securities, MF sales, deposits etc)
  const sftMatch = norm.match(/Part\s*B2[^]*?(?:Part\s*B[37]|$)/i);
  if (sftMatch) {
    const sftText = sftMatch[0];
    if (!/No\s+Transactions?\s+Present/i.test(sftText)) {
      // Sale of securities/MF
      const saleMatches = [...sftText.matchAll(/(?:SALES?\s+CONSIDERATION|Value\s+of\s+consideration|Sale\s+(?:Amount|Value|Price))[^\d]*?([\d,]+(?:\.\d+)?)/gi)];
      if (saleMatches.length > 0) {
        const total = saleMatches.reduce((s, m) => s + parseFloat(m[1].replace(/,/g, '')), 0);
        if (total > 0) result.categories.sale_securities = { name: 'Sale of Securities/MF', processed: total, reported: 0 };
      }
      
      // Extract individual transaction amounts
      const txnAmounts = [...sftText.matchAll(/([\d,]+(?:\.\d{2})?)\s/g)]
        .map(m => parseFloat(m[1].replace(/,/g, '')))
        .filter(v => v >= 100 && v < 100000000); // reasonable transaction range
      
      if (txnAmounts.length > 0 && !result.categories.sale_securities) {
        result.categories.sft_transactions = { 
          name: 'SFT Transactions', 
          processed: txnAmounts.reduce((a, b) => a + b, 0), 
          reported: 0,
          count: txnAmounts.length 
        };
      }
    }
  }

  // Salary section
  const salaryMatch = norm.match(/(?:Salary|Salaries)[^]*?(?:Aggregate|Total)[^\d]*?([\d,]+(?:\.\d+)?)/i);
  if (salaryMatch) {
    const val = parseFloat(salaryMatch[1].replace(/,/g, ''));
    if (val > 0) result.categories.salary = { name: 'Salary', processed: val, reported: 0 };
  }

  // Interest sections
  const interestMatch = norm.match(/Interest[^]*?(?:Aggregate|Total)[^\d]*?([\d,]+(?:\.\d+)?)/i);
  if (interestMatch) {
    const val = parseFloat(interestMatch[1].replace(/,/g, ''));
    if (val > 0) result.categories.interest = { name: 'Interest', processed: val, reported: 0 };
  }

  // Dividend
  const dividendMatch = norm.match(/Dividend[^]*?(?:Aggregate|Total)[^\d]*?([\d,]+(?:\.\d+)?)/i);
  if (dividendMatch) {
    const val = parseFloat(dividendMatch[1].replace(/,/g, ''));
    if (val > 0) result.categories.dividend = { name: 'Dividend', processed: val, reported: 0 };
  }

  // Rent received
  const rentMatch = norm.match(/Rent\s+(?:Received|Income)[^]*?(?:Aggregate|Total)[^\d]*?([\d,]+(?:\.\d+)?)/i);
  if (rentMatch) {
    const val = parseFloat(rentMatch[1].replace(/,/g, ''));
    if (val > 0) result.categories.rent = { name: 'Rent', processed: val, reported: 0 };
  }

  // Refund section
  const refundMatch = norm.match(/Refund[^]*?(?:AMOUNT|Total)[^\d]*?([\d,]+(?:\.\d+)?)/i);
  if (refundMatch) {
    const val = parseFloat(refundMatch[1].replace(/,/g, ''));
    if (val > 0) result.categories.refund = { name: 'Refund', processed: val, reported: 0 };
  }

  // ===== TIS specific parsing =====
  // TIS has sections like: "Reported Value", "Derived Value" etc
  const tisPatterns = [
    { key: 'salary', rx: /Salary[^]*?(?:Derived|Processed)\s+Value[^\d]*?([\d,]+(?:\.\d+)?)/i },
    { key: 'interest_savings', rx: /Interest\s+(?:from\s+)?Saving[^]*?(?:Derived|Processed)\s+Value[^\d]*?([\d,]+(?:\.\d+)?)/i },
    { key: 'interest_deposit', rx: /Interest\s+(?:from\s+)?(?:Deposit|FD|Fixed)[^]*?(?:Derived|Processed)\s+Value[^\d]*?([\d,]+(?:\.\d+)?)/i },
    { key: 'interest_other', rx: /Interest\s+(?:from\s+)?Other[^]*?(?:Derived|Processed)\s+Value[^\d]*?([\d,]+(?:\.\d+)?)/i },
    { key: 'dividend', rx: /Dividend[^]*?(?:Derived|Processed)\s+Value[^\d]*?([\d,]+(?:\.\d+)?)/i },
    { key: 'rent', rx: /Rent[^]*?(?:Derived|Processed)\s+Value[^\d]*?([\d,]+(?:\.\d+)?)/i },
    { key: 'sale_securities', rx: /Sale\s+of\s+(?:Securities|Shares|Mutual)[^]*?(?:Derived|Processed)\s+Value[^\d]*?([\d,]+(?:\.\d+)?)/i },
    { key: 'business_receipts', rx: /(?:Business|Professional)\s+(?:Receipts|Income)[^]*?(?:Derived|Processed)\s+Value[^\d]*?([\d,]+(?:\.\d+)?)/i }
  ];

  for (const p of tisPatterns) {
    const m = norm.match(p.rx);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val > 0 && !result.categories[p.key]) {
        result.categories[p.key] = { name: p.key, processed: val, reported: 0 };
      }
    }
  }

  // ===== TIS summary table: "SR.NO CATEGORY PROCESSED ACCEPTED" =====
  // Format: "1 Sale of securities and units of mutual fund 5,000 5,000"
  const tisTablePatterns = [
    { key: 'salary', rx: /\d+\s+(?:Salary|Salaries)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'interest_savings', rx: /\d+\s+Interest\s+(?:from\s+)?(?:Saving|savings?\s+bank)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'interest_deposit', rx: /\d+\s+Interest\s+(?:from\s+)?(?:Deposit|FD|Fixed|recurring)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'interest_other', rx: /\d+\s+Interest\s+(?:from\s+)?(?:Others?|refund)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'dividend', rx: /\d+\s+Dividend\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'rent', rx: /\d+\s+Rent\s+(?:received|payment)?\s*([\d,]+)\s+([\d,]+)/i },
    { key: 'sale_securities', rx: /\d+\s+Sale\s+of\s+securities\s+and\s+units?\s+of\s+mutual\s+fund\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'purchase_immovable', rx: /\d+\s+Purchase\s+of\s+(?:Immovable|land|property)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'sale_immovable', rx: /\d+\s+Sale\s+of\s+(?:Immovable|land|property)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'business_receipts', rx: /\d+\s+(?:Business|Professional)\s+(?:Receipts?|Income)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'cash_deposit', rx: /\d+\s+(?:Cash\s+)?(?:Deposit|deposits?)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'cash_withdrawal', rx: /\d+\s+(?:Cash\s+)?(?:Withdrawal|withdrawals?)\s+([\d,]+)\s+([\d,]+)/i },
    { key: 'foreign_remittance', rx: /\d+\s+Foreign\s+(?:remittance|exchange)\s+([\d,]+)\s+([\d,]+)/i }
  ];

  for (const p of tisTablePatterns) {
    const m = norm.match(p.rx);
    if (m) {
      const processed = parseFloat(m[1].replace(/,/g, ''));
      const accepted = parseFloat(m[2].replace(/,/g, ''));
      if (processed > 0 && !result.categories[p.key]) {
        result.categories[p.key] = { name: p.key, processed, reported: accepted };
      }
    }
  }

  // Extract section headings for summary
  const sectionNames = [...norm.matchAll(/Part\s+B\d+\s*[-–]\s*(.+?)(?:\s{2,}|SR\.|$)/gi)];
  result.sections = sectionNames.map(m => m[1].trim());

  // Check which parts have "No Transactions Present"
  const noTxParts = [...norm.matchAll(/Part\s+B\d+[^]*?No\s+Transactions?\s+Present/gi)];
  result.emptyParts = noTxParts.length;

  // Build raw summary
  result.rawSummary = norm.substring(0, 500);

  return result;
}

async function analyzeAllPDFs(downloadDir, pan, dob) {
  // Build password: lowercasePAN + DOB(ddmmyyyy)
  let password = '';
  if (pan && dob) {
    let dd, mm, yyyy;
    if (dob.includes('-') && dob.indexOf('-') === 4) {
      [yyyy, mm, dd] = dob.split('-');
    } else if (dob.includes('/')) {
      [dd, mm, yyyy] = dob.split('/');
    } else if (dob.includes('-')) {
      [dd, mm, yyyy] = dob.split('-');
    }
    if (dd && mm && yyyy) {
      password = pan.toLowerCase() + dd + mm + yyyy;
    }
  }

  const results = { ais: {}, tis: {}, password };

  // Scan both ais and tis directories
  const dirs = [
    path.join(downloadDir, 'ais'),
    path.join(downloadDir, 'tis')
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));
    
    for (const file of files) {
      const filePath = path.join(dir, file);
      const isAIS = file.toUpperCase().includes('_AIS');
      const isTIS = file.toUpperCase().includes('_TIS');
      const targetType = isTIS ? 'tis' : 'ais';
      
      try {
        const { text, pages } = await extractPdfText(filePath, password);
        
        // Save extracted text
        const txtFile = file.replace('.pdf', '_text.txt');
        fs.writeFileSync(path.join(dir, txtFile), text);

        // Parse
        const parsed = parseAISPdfText(text, isAIS);

        // Extract FY from filename
        const fyMatch = file.match(/(\d{4}-\d{2})/);
        const fy = fyMatch ? fyMatch[1] : 'unknown';

        results[targetType][fy] = {
          file,
          pages,
          categories: parsed.categories,
          sections: parsed.sections,
          emptyParts: parsed.emptyParts,
          rawSummary: parsed.rawSummary,
          textLength: text.length
        };
      } catch (e) {
        results[targetType][file] = { error: e.message };
      }
    }
  }

  return results;
}

module.exports = { extractPdfText, parseAISPdfText, analyzeAllPDFs };
