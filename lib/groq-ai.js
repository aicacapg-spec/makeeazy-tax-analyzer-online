// lib/groq-ai.js — Groq AI integration for deep tax analysis
const fs = require('fs');
const path = require('path');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// Models
const MODELS = {
  REASONING: 'openai/gpt-oss-120b',   // Deep reasoning with thinking
  FAST:      'openai/gpt-oss-20b',     // Fast reasoning
  VISION:    'meta-llama/llama-4-scout-17b-16e-instruct', // Vision/OCR
  QUICK:     'llama-3.3-70b-versatile'  // Quick text tasks
};

async function groqCall({ model, messages, temperature = 0.3, maxTokens = 4096, reasoning = false, jsonMode = false }) {
  const body = {
    model,
    messages,
    temperature,
    max_completion_tokens: maxTokens,
    stream: false
  };

  if (reasoning && model.includes('gpt-oss')) {
    body.include_reasoning = true;
    body.reasoning_effort = 'high';
    // GPT-OSS doesn't support json_mode with reasoning — JSON is requested in prompt
  } else if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const resp = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const choice = data.choices?.[0]?.message;
  let content = choice?.content || '';
  const reasoningText = choice?.reasoning || '';  // GPT-OSS 120B sometimes returns empty content but puts JSON in reasoning
  if (!content && reasoningText) {
    console.log('[GROQ] Content empty, extracting from reasoning...');
    
    // Strategy 1: ```json blocks
    const jsonBlock = reasoningText.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlock) {
      content = jsonBlock[1].trim();
      console.log('[GROQ] Found ```json block:', content.length, 'chars');
    }
    
    // Strategy 2: Find largest balanced JSON object using bracket matching
    if (!content) {
      const positions = [];
      for (let i = 0; i < reasoningText.length; i++) {
        if (reasoningText[i] === '{') {
          let depth = 0;
          let inStr = false;
          let esc = false;
          for (let j = i; j < reasoningText.length; j++) {
            const c = reasoningText[j];
            if (esc) { esc = false; continue; }
            if (c === String.fromCharCode(92) && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            if (c === '}') {
              depth--;
              if (depth === 0) { positions.push([i, j + 1]); break; }
            }
          }
        }
      }
      // Pick the largest JSON block (likely the full analysis)
      if (positions.length > 0) {
        positions.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
        const [start, end] = positions[0];
        const candidate = reasoningText.substring(start, end);
        if (candidate.length > 100) {
          content = candidate;
          console.log('[GROQ] Extracted JSON block:', content.length, 'chars');
        }
      }
    }
  }
  
  return {
    content,
    reasoning: reasoningText,
    model: data.model,
    usage: data.usage
  };
}

// ========== MAIN: Deep Tax Profile Analysis ==========
async function generateTaxProfile(reportData, itrJsons, pdfTexts, profile) {
  const log = (msg) => console.log(`[GROQ] ${msg}`);
  
  // Build comprehensive data summary for AI
  log('Building data summary...');
  const dataSummary = buildDataSummary(reportData, itrJsons, pdfTexts, profile);
  log(`Data summary: ${dataSummary.length} chars`);

  const systemPrompt = `You are an expert Indian Chartered Accountant analyzing a taxpayer's filed ITR data. Rules:
- All amounts in INR. FY=Apr-Mar, AY=FY+1.
- The taxpayer's ACTUAL regime is specified per year (New/Old). Only recommend deductions valid for their regime.
- Under New Regime: no 80C/80D/80G/HRA deductions allowed, only standard deduction ₹75000 (FY24-25+).
- Under Old Regime: 80C (₹1.5L), 80D, 80G, HRA, LTA etc. are available.
- Use EXACT amounts from the data, never estimate.
- Respond ONLY with valid JSON.`;

  const userPrompt = `Analyze this taxpayer and respond with JSON: taxpayerProfile (name,pan,dob,category,riskScore 0-100,summaryLine), incomeAnalysis (yearWise array: ay,grossIncome,taxableIncome,taxPaid,effectiveTaxRate,regime,itrType + trends object), complianceCheck (overallStatus,checks array with check,status,detail), aisVsItrMismatch (array), taxOptimization (currentRegime,optimalRegime,potentialSavings,recommendations array), redFlags (array with flag,severity,detail), executiveSummary (string).

DATA:
${dataSummary}`;

  let deepAnalysis;
  
  // Try GPT-OSS 120B with reasoning first
  try {
    log('Trying GPT-OSS 120B with reasoning...');
    deepAnalysis = await groqCall({
      model: MODELS.REASONING,
      reasoning: true,
      maxTokens: 4096,
      jsonMode: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
  } catch (e) {
    log(`120B failed: ${e.message.substring(0, 100)}`);
    // Fallback to GPT-OSS 20B (lower token usage)
    log('Falling back to GPT-OSS 20B...');
    const shortSummary = buildDataSummary(reportData, itrJsons, {}, profile); // no PDF text
    try {
      deepAnalysis = await groqCall({
        model: MODELS.FAST,
        reasoning: true,
        maxTokens: 4096,
        jsonMode: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this taxpayer and respond with JSON containing: taxpayerProfile, incomeAnalysis, complianceCheck, taxOptimization, redFlags, executiveSummary.\n\nDATA:\n${shortSummary}` }
        ]
      });
    } catch (e2) {
      log(`20B also failed: ${e2.message.substring(0, 100)}`);
      // Final fallback: Llama 3.3 70B (higher token limits)
      log('Final fallback to Llama 3.3 70B...');
      deepAnalysis = await groqCall({
        model: MODELS.QUICK,
        maxTokens: 4096,
        jsonMode: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this taxpayer and respond with JSON containing: taxpayerProfile, incomeAnalysis, complianceCheck, taxOptimization, redFlags, executiveSummary.\n\nDATA:\n${shortSummary}` }
        ]
      });
    }
  }

  log(`Analysis complete. Reasoning: ${deepAnalysis.reasoning?.length || 0} chars`);

  // If content is still empty after extraction, retry with Llama 70B
  if (!deepAnalysis.content || deepAnalysis.content.trim().length < 10) {
    log('Content still empty after extraction! Retrying with Llama 70B...');
    try {
      const shortSummary = buildDataSummary(reportData, itrJsons, {}, profile);
      const llamaPrompt = `Analyze this taxpayer and respond with ONLY a valid JSON object with these exact keys:
{
  "taxpayerProfile": { "name": "string", "pan": "string", "dob": "string or null", "category": "Individual", "riskScore": 0-100, "summaryLine": "one line summary" },
  "incomeAnalysis": { "yearWise": [ { "ay": "2024-25", "itrType": "ITR3", "regime": "New Regime", "grossIncome": 0, "taxableIncome": 0, "taxPaid": 0, "effectiveTaxRate": "0%" } ] },
  "complianceCheck": { "overallStatus": "Compliant or Non-Compliant", "checks": [ { "check": "name", "status": "Pass or Fail", "detail": "description" } ] },
  "taxOptimization": { "currentRegime": "New Regime", "optimalRegime": "New/Old", "potentialSavings": 0, "recommendations": [ { "title": "short title", "description": "detail", "priority": "High/Medium/Low" } ] },
  "redFlags": [ { "flag": "title", "severity": "High/Medium/Low", "detail": "description" } ],
  "executiveSummary": "2-3 sentence summary string"
}

DATA:
${shortSummary}`;
      deepAnalysis = await groqCall({
        model: MODELS.QUICK,
        maxTokens: 4096,
        jsonMode: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: llamaPrompt }
        ]
      });
      log(`Llama 70B returned ${deepAnalysis.content?.length || 0} chars`);
    } catch(retryErr) {
      log(`Llama retry failed: ${retryErr.message}`);
    }
  }

  // Parse the AI response — handle common AI JSON issues
  let aiReport = {};
  let rawContent = (deepAnalysis.content || '').trim();
  log(`Content length: ${rawContent.length} chars`);
  
  // Strip markdown code fences if present
  rawContent = rawContent.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  
  // Aggressive JSON repair
  function repairJson(str) {
    return str
      .replace(/,\s*}/g, '}')           // trailing commas before }
      .replace(/,\s*]/g, ']')           // trailing commas before ]
      .replace(/:\s*NaN/g, ': 0')       // NaN
      .replace(/:\s*Infinity/g, ': 0')  // Infinity
      .replace(/:\s*undefined/g, ': null') // undefined
      .replace(/\/\/[^\n]*/g, '')       // single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '')  // multi-line comments
      .replace(/\n/g, ' ')              // newlines to spaces
      .replace(/\t/g, ' ');             // tabs to spaces
  }

  // Strategy 1: Direct parse
  try {
    aiReport = JSON.parse(rawContent);
  } catch (e) {
    // Strategy 2: Repair and parse
    try {
      aiReport = JSON.parse(repairJson(rawContent));
    } catch(e2) {
      // Strategy 3: Extract JSON block and repair
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          aiReport = JSON.parse(repairJson(jsonMatch[0]));
        } catch(e3) {
          // Strategy 4: Truncate at last valid closing brace
          const lastBrace = rawContent.lastIndexOf('}');
          if (lastBrace > 0) {
            let truncated = rawContent.substring(0, lastBrace + 1);
            // Balance braces
            const opens = (truncated.match(/\{/g) || []).length;
            const closes = (truncated.match(/\}/g) || []).length;
            for (let i = 0; i < opens - closes; i++) truncated += '}';
            // Balance brackets
            const bo = (truncated.match(/\[/g) || []).length;
            const bc = (truncated.match(/\]/g) || []).length;
            for (let i = 0; i < bo - bc; i++) truncated += ']';
            try {
              aiReport = JSON.parse(repairJson(truncated));
            } catch(e4) {
              log(`JSON parse final error at pos: ${e4.message}`);
              aiReport = { parseError: true, executiveSummary: 'Analysis completed but response format error. Re-running with fallback...' };
            }
          } else {
            aiReport = { parseError: true, executiveSummary: 'No valid JSON in response.' };
          }
        }
      }
    }
  }
  
  // If parse failed OR report is missing essential fields, retry with QUICK model
  if (!aiReport.taxpayerProfile && !aiReport.executiveSummary) {
    aiReport.parseError = true;
    log('Report missing essential fields (taxpayerProfile/executiveSummary)');
  }
  if (aiReport.parseError) {
    log('JSON parse failed, retrying with Llama 70B...');
    try {
      const shortSummary = buildDataSummary(reportData, itrJsons, {}, profile);
      const retryPrompt = `Analyze this taxpayer and respond with ONLY a valid JSON object with these exact keys:
{
  "taxpayerProfile": { "name": "string", "pan": "string", "dob": "string or null", "category": "Individual", "riskScore": 0-100, "summaryLine": "one line summary" },
  "incomeAnalysis": { "yearWise": [ { "ay": "2024-25", "itrType": "ITR3", "regime": "New Regime", "grossIncome": 0, "taxableIncome": 0, "taxPaid": 0, "effectiveTaxRate": "0%" } ] },
  "complianceCheck": { "overallStatus": "Compliant or Non-Compliant", "checks": [ { "check": "name", "status": "Pass or Fail", "detail": "description" } ] },
  "taxOptimization": { "currentRegime": "New Regime", "optimalRegime": "New/Old", "potentialSavings": 0, "recommendations": [ { "title": "short title", "description": "detail", "priority": "High/Medium/Low" } ] },
  "redFlags": [ { "flag": "title", "severity": "High/Medium/Low", "detail": "description" } ],
  "executiveSummary": "2-3 sentence summary string"
}

DATA:
${shortSummary}`;
      const retryAnalysis = await groqCall({
        model: MODELS.QUICK,
        maxTokens: 4096,
        jsonMode: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: retryPrompt }
        ]
      });
      const retryContent = (retryAnalysis.content || '').trim()
        .replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      try {
        aiReport = JSON.parse(repairJson(retryContent));
        aiReport._model = retryAnalysis.model;
        log('Retry with Llama 70B succeeded!');
      } catch(re) {
        log(`Retry also failed: ${re.message}`);
      }
    } catch(retryErr) {
      log(`Retry API call failed: ${retryErr.message}`);
    }
  }

  // Store model info but NOT reasoning/prompts (don't expose to client)
  aiReport._model = deepAnalysis.model;

  return aiReport;
}

// Build comprehensive data summary for AI prompt
function buildDataSummary(reportData, itrJsons, pdfTexts, profile) {
  const parts = [];

  // Profile
  parts.push(`=== TAXPAYER ===`);
  parts.push(`PAN: ${profile.pan || 'N/A'}, Name: ${profile.name || 'N/A'}, DOB: ${profile.dob || 'N/A'}`);

  // Year-wise ITR data from our analyzer
  const yearly = reportData?.yearlyITR || [];
  if (yearly.length > 0) {
    parts.push(`\n=== FILED ITR DATA (${yearly.length} years) ===`);
    for (const y of yearly) {
      const inc = y.income || {};
      const ded = y.deductions || {};
      const tax = y.tax || {};
      parts.push(`\n--- AY ${y.ay} | ${y.itrType || y.detectedType} | ${y.regime} | ${y.filingType || ''} ---`);
      parts.push(`Gross Total: ₹${formatNum(y.grossTotal)}, Taxable: ₹${formatNum(y.totalIncome)}`);
      
      // Income breakdown
      const incItems = [];
      if (inc.salary) incItems.push(`Salary:₹${formatNum(inc.salary)}`);
      if (inc.houseProperty) incItems.push(`HP:₹${formatNum(inc.houseProperty)}`);
      if (inc.businessProfession) incItems.push(`Business:₹${formatNum(inc.businessProfession)}`);
      if (inc.capitalGains?.stcg) incItems.push(`STCG:₹${formatNum(inc.capitalGains.stcg)}`);
      if (inc.capitalGains?.ltcg) incItems.push(`LTCG:₹${formatNum(inc.capitalGains.ltcg)}`);
      if (inc.otherSources) incItems.push(`Other:₹${formatNum(inc.otherSources)}`);
      if (inc.exemptIncome) incItems.push(`Exempt:₹${formatNum(inc.exemptIncome)}`);
      if (incItems.length) parts.push(`Income: ${incItems.join(', ')}`);

      // Other sources detail
      if (inc.otherSourcesBreakdown?.length) {
        parts.push(`Other Sources Detail: ${inc.otherSourcesBreakdown.map(o => `${o.description}:₹${o.amount}`).join(', ')}`);
      }

      // Deductions
      if (ded.total > 0) {
        const dedItems = [];
        if (ded.sec80C) dedItems.push(`80C:₹${formatNum(ded.sec80C)}`);
        if (ded.sec80D) dedItems.push(`80D:₹${formatNum(ded.sec80D)}`);
        if (ded.sec80G) dedItems.push(`80G:₹${formatNum(ded.sec80G)}`);
        if (ded.sec80TTA) dedItems.push(`80TTA:₹${formatNum(ded.sec80TTA)}`);
        if (ded.sec80CCD) dedItems.push(`80CCD:₹${formatNum(ded.sec80CCD)}`);
        parts.push(`Deductions (Total ₹${formatNum(ded.total)}): ${dedItems.join(', ')}`);
      } else {
        parts.push(`Deductions: Nil (No deductions claimed)`);
      }

      // Tax computation
      parts.push(`Tax: onIncome:₹${formatNum(tax.onIncome)}, Rebate87A:₹${formatNum(tax.rebate87A)}, GrossLiability:₹${formatNum(tax.totalLiability)}, NetLiability:₹${formatNum(tax.netLiability)}`);
      parts.push(`Paid: TDS:₹${formatNum(tax.tds)}, AdvanceTax:₹${formatNum(tax.advanceTax)}, SelfAssessment:₹${formatNum(tax.selfAssessment)}, TotalPaid:₹${formatNum(tax.totalPaid)}`);
      if (tax.refund) parts.push(`Refund Due: ₹${formatNum(tax.refund)}`);
      if (tax.payable) parts.push(`Balance Payable: ₹${formatNum(tax.payable)}`);

      // Presumptive schedule
      if (y.schedules?.presumptive) {
        const p = y.schedules.presumptive;
        if (p.sec44AD || p.sec44ADA) {
          parts.push(`Presumptive: 44AD:₹${formatNum(p.sec44AD)}, 44ADA:₹${formatNum(p.sec44ADA)}, TurnoverCash:₹${formatNum(p.turnoverGross)}, TurnoverDigital:₹${formatNum(p.turnoverDigital)}`);
        }
      }
    }
  }

  // Summary info
  if (reportData?.summary) {
    const s = reportData.summary;
    parts.push(`\n=== SUMMARY ===`);
    parts.push(`Returns: ${s.totalReturns}, Downloaded: ${s.downloaded}, ITR Types: ${JSON.stringify(s.itrTypesUsed)}`);
    parts.push(`Latest: AY ${s.latestAY}, Regime: ${s.latestRegime}, Income: ₹${formatNum(s.latestIncome)}, Tax: ₹${formatNum(s.latestTax)}`);
  }

  // Cross-verification
  if (reportData?.crossVerification) {
    const mismatches = reportData.crossVerification.filter(cv => cv.mismatches?.length > 0);
    if (mismatches.length > 0) {
      parts.push(`\n=== MISMATCHES (ITR vs TIS) ===`);
      for (const cv of mismatches) {
        for (const m of cv.mismatches) {
          parts.push(`AY ${cv.ay}: ${m.field} — ITR:₹${formatNum(m.itr)} vs TIS:₹${formatNum(m.tis)}`);
        }
      }
    }
  }

  // AIS/TIS PDF text (truncated)
  if (pdfTexts && Object.keys(pdfTexts).length > 0) {
    parts.push(`\n=== AIS/TIS PDF DATA ===`);
    for (const [key, text] of Object.entries(pdfTexts)) {
      if (text && text.length > 50) {
        parts.push(`--- ${key} ---`);
        parts.push(text.substring(0, 600));
      }
    }
  }

  return parts.join('\n');
}

function formatNum(n) {
  if (!n || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-IN');
}

// Quick summary using fast model
async function quickSummary(text) {
  const result = await groqCall({
    model: MODELS.FAST,
    maxTokens: 512,
    messages: [
      { role: 'system', content: 'You are a concise tax data summarizer. Summarize in 2-3 bullet points.' },
      { role: 'user', content: `Summarize this tax data:\n${text.substring(0, 2000)}` }
    ]
  });
  return result.content;
}

// OCR/Vision for document images
async function ocrDocument(base64Image, documentType = 'tax document') {
  const result = await groqCall({
    model: MODELS.VISION,
    maxTokens: 4096,
    jsonMode: true,
    messages: [
      { 
        role: 'user',
        content: [
          { type: 'text', text: `Extract all text and financial data from this ${documentType}. Return as JSON with fields: documentType, assessmentYear, sections (array of {name, data}).` },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]
      }
    ]
  });
  try {
    return JSON.parse(result.content);
  } catch(e) {
    return { raw: result.content };
  }
}

// Follow-up questions about the taxpayer — reads full ITR JSONs + report
async function askAboutTaxpayer(question, reportData, profile, itrJsons) {
  const summary = buildDataSummary(reportData, itrJsons || [], {}, profile);
  
  const sysMsg = `You are an expert Indian Chartered Accountant and tax consultant working for MakeEazy. 
Answer the user's question based on their filed ITR data and tax computations.

RULES:
- Give answers in CLEAR POINTWISE format with bullet points, NOT as JSON or code blocks
- Use exact amounts from the data (₹ symbol with Indian number formatting)
- The taxpayer's actual regime is given in the data — only give advice relevant to that regime
- Under New Regime: 80C/80D/80G/HRA deductions are NOT available
- Under Old Regime: 80C (₹1.5L), 80D, 80G, HRA, LTA etc. are available
- Be specific and actionable
- Use **bold** for important amounts and headings
- Add section references (e.g., "u/s 87A", "Sec 80C") where relevant
- Keep answer concise but complete`;

  const userMsg = `Taxpayer Data:\n${summary.substring(0, 4000)}\n\nQuestion: ${question}`;
  
  // Try GPT-OSS 20B first, fallback to Llama 70B
  let result;
  try {
    result = await groqCall({
      model: MODELS.FAST,
      reasoning: true,
      maxTokens: 2048,
      messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }]
    });
  } catch(e) {
    result = { content: '' };
  }
  
  // If empty, retry with Llama 70B
  if (!result.content || result.content.trim().length < 10) {
    result = await groqCall({
      model: MODELS.QUICK,
      maxTokens: 2048,
      messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }]
    });
  }
  
  return { answer: result.content };
}

module.exports = { generateTaxProfile, quickSummary, ocrDocument, askAboutTaxpayer, groqCall, MODELS };
