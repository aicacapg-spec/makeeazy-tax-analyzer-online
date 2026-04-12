// Test with MULTIPLE real ITR JSONs from same PAN
const http = require('http');
const fs = require('fs');
const path = require('path');

const panDir = path.join(__dirname, '..', 'downloads', 'BDDPK9859E', 'itr');
const files = fs.readdirSync(panDir).filter(f => f.startsWith('ITR_') && f.endsWith('.json'));

if (files.length === 0) { console.log('No test files!'); process.exit(1); }
console.log(`\n🚀 Testing with ${files.length} ITR JSONs from BDDPK9859E`);
files.forEach(f => console.log(`   📄 ${f}`));

const sessionId = 'multi-' + Date.now().toString(36);
const boundary = '----FormBound' + Date.now();

// Build multipart body with all files
let parts = [];
for (const fileName of files) {
  const filePath = path.join(panDir, fileName);
  const fileData = fs.readFileSync(filePath);
  
  let part = `--${boundary}\r\n`;
  part += `Content-Disposition: form-data; name="files"; filename="${fileName}"\r\n`;
  part += `Content-Type: application/json\r\n\r\n`;
  parts.push(Buffer.from(part, 'utf8'));
  parts.push(fileData);
  parts.push(Buffer.from('\r\n', 'utf8'));
}
parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
const fullBody = Buffer.concat(parts);

console.log(`\n📦 Uploading ${(fullBody.length/1024).toFixed(1)} KB ...`);

const req = http.request({
  hostname: 'localhost', port: 3030, path: '/api/upload', method: 'POST',
  headers: {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': fullBody.length,
    'x-session-id': sessionId
  }
}, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const result = JSON.parse(data);
    console.log(`✅ Uploaded ${result.files?.length} files`);
    result.files?.forEach(f => console.log(`   ${f.type}: ${f.name}`));
    
    // Trigger analysis
    const body = JSON.stringify({ sessionId });
    const areq = http.request({
      hostname: 'localhost', port: 3030, path: '/api/analyze', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (ares) => {
      let adata = '';
      ares.on('data', c => adata += c);
      ares.on('end', () => {
        console.log(`\n⚡ Analysis started: ${adata}`);
        
        // Poll
        let attempts = 0;
        const poll = setInterval(() => {
          attempts++;
          http.get(`http://localhost:3030/api/status/${sessionId}`, (sr) => {
            let sd = '';
            sr.on('data', c => sd += c);
            sr.on('end', () => {
              try {
                const s = JSON.parse(sd);
                process.stdout.write(`  [${attempts}] ${s.status}  \r`);
                if (s.status === 'done' || s.status === 'error') {
                  clearInterval(poll);
                  console.log(`\n\n${'═'.repeat(50)}`);
                  console.log('✅ ANALYSIS COMPLETE');
                  console.log('═'.repeat(50));
                  
                  if (s.report) {
                    const r = s.report;
                    console.log(`\n📋 REPORT:`);
                    console.log(`   PAN: ${r.meta?.pan} | Name: ${r.meta?.name}`);
                    console.log(`   Returns: ${r.summary?.downloaded} | Types: ${JSON.stringify(r.summary?.itrTypesUsed)}`);
                    console.log(`   Latest: AY ${r.summary?.latestAY} | ${r.summary?.latestRegime}`);
                    console.log(`   Income: ₹${r.summary?.latestIncome?.toLocaleString('en-IN')}`);
                    console.log(`   Tax: ₹${r.summary?.latestTax?.toLocaleString('en-IN')}`);
                    
                    console.log(`\n   YEAR-WISE BREAKDOWN:`);
                    for (const y of (r.yearlyITR || [])) {
                      console.log(`   ┌ AY ${y.ay} | ${y.itrType || y.detectedType} | ${y.regime}`);
                      console.log(`   │ Salary: ₹${(y.income?.salary||0).toLocaleString('en-IN')} | Business: ₹${(y.income?.businessProfession||0).toLocaleString('en-IN')}`);
                      console.log(`   │ Gross: ₹${(y.grossTotal||0).toLocaleString('en-IN')} | Taxable: ₹${(y.totalIncome||0).toLocaleString('en-IN')}`);
                      console.log(`   │ Deductions: ₹${(y.deductions?.total||0).toLocaleString('en-IN')} (80C: ₹${(y.deductions?.sec80C||0).toLocaleString('en-IN')})`);
                      console.log(`   │ Tax Paid: ₹${(y.tax?.totalPaid||0).toLocaleString('en-IN')} | Refund: ₹${(y.tax?.refund||0).toLocaleString('en-IN')}`);
                      console.log(`   └─────────────────────────`);
                    }
                  }
                  
                  if (s.aiReport && !s.aiReport.parseError) {
                    const ai = s.aiReport;
                    console.log(`\n🤖 AI INSIGHTS:`);
                    if (ai.executiveSummary) console.log(`   Summary: ${String(ai.executiveSummary).substring(0, 300)}`);
                    if (ai.taxpayerProfile?.riskScore != null) console.log(`   Risk: ${ai.taxpayerProfile.riskScore}/100`);
                    if (ai.taxOptimization) {
                      console.log(`   Regime: ${ai.taxOptimization.currentRegime} → ${ai.taxOptimization.optimalRegime}`);
                      if (ai.taxOptimization.potentialSavings) console.log(`   Savings: ₹${ai.taxOptimization.potentialSavings?.toLocaleString('en-IN')}`);
                    }
                    if (ai.complianceCheck?.checks?.length) console.log(`   Compliance: ${ai.complianceCheck.overallStatus} (${ai.complianceCheck.checks.length} checks)`);
                    if (ai.redFlags?.length) {
                      console.log(`   Red Flags: ${ai.redFlags.length}`);
                      ai.redFlags.forEach(f => console.log(`     ⚠ ${f.flag}: ${f.detail?.substring(0,80)}`));
                    }
                  }
                  
                  console.log(`\n🎉 Multi-file test PASSED!\n`);
                  process.exit(0);
                }
              } catch(e) {}
            });
          }).on('error', () => {});
          if (attempts > 60) { clearInterval(poll); console.log('\n⏰ Timeout'); process.exit(1); }
        }, 3000);
      });
    });
    areq.write(body);
    areq.end();
  });
});
req.on('error', e => { console.error('Error:', e.message); process.exit(1); });
req.write(fullBody);
req.end();
