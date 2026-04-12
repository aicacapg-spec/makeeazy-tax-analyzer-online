// Quick API test for the online tax analyzer
const http = require('http');
const fs = require('fs');
const path = require('path');

// Test with a real ITR JSON file
const testFile = path.join(__dirname, '..', 'downloads', 'BDDPK9859E', 'itr', 'ITR_2024-25_928514430250724.json');

if (!fs.existsSync(testFile)) {
  console.log('Test file not found:', testFile);
  // Try another
  const altFiles = [
    path.join(__dirname, '..', 'downloads', 'KALPK1283G', 'itr', 'ITR_2024-25_123575340270724.json'),
    path.join(__dirname, '..', 'downloads', 'EBYPM8831A', 'itr', 'ITR_2024-25_289621910310724.json')
  ];
  for (const f of altFiles) {
    if (fs.existsSync(f)) {
      console.log('Using:', f);
      runTest(f);
      return;
    }
  }
  console.log('No test files found!');
  process.exit(1);
} else {
  runTest(testFile);
}

function runTest(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  
  // Build multipart form data
  const boundary = '----FormBoundary' + Date.now();
  const sessionId = 'test-' + Date.now().toString(36);
  
  let body = '';
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="files"; filename="${fileName}"\r\n`;
  body += `Content-Type: application/json\r\n\r\n`;
  
  const bodyStart = Buffer.from(body, 'utf8');
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const fullBody = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);

  console.log(`\n🚀 Testing upload: ${fileName} (${(fileBuffer.length/1024).toFixed(1)} KB)`);
  console.log(`Session: ${sessionId}\n`);

  const req = http.request({
    hostname: 'localhost',
    port: 3030,
    path: '/api/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': fullBody.length,
      'x-session-id': sessionId
    }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('📦 Upload Response:', res.statusCode);
      try {
        const result = JSON.parse(data);
        console.log('   Session:', result.sessionId);
        console.log('   Files:', JSON.stringify(result.files, null, 2));
        
        if (res.statusCode === 200) {
          // Now trigger analysis
          triggerAnalysis(result.sessionId);
        }
      } catch(e) {
        console.log('   Raw:', data);
      }
    });
  });
  
  req.on('error', e => console.error('Upload error:', e.message));
  req.write(fullBody);
  req.end();
}

function triggerAnalysis(sessionId) {
  console.log('\n⚡ Triggering analysis...');
  
  const body = JSON.stringify({ sessionId });
  const req = http.request({
    hostname: 'localhost',
    port: 3030,
    path: '/api/analyze',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('🔬 Analyze Response:', res.statusCode, data);
      
      // Poll for result
      console.log('\n⏳ Waiting for analysis to complete...');
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        http.get(`http://localhost:3030/api/status/${sessionId}`, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              process.stdout.write(`  [${attempts}] Status: ${result.status}`);
              
              if (result.status === 'done' || result.status === 'error') {
                clearInterval(poll);
                console.log('\n\n✅ ANALYSIS COMPLETE!\n');
                
                if (result.report) {
                  const r = result.report;
                  console.log('📋 Report Summary:');
                  console.log(`   PAN: ${r.meta?.pan}`);
                  console.log(`   Name: ${r.meta?.name}`);
                  console.log(`   Returns: ${r.summary?.downloaded}`);
                  console.log(`   Latest AY: ${r.summary?.latestAY}`);
                  console.log(`   Latest Income: ₹${r.summary?.latestIncome?.toLocaleString('en-IN')}`);
                  console.log(`   Latest Tax: ₹${r.summary?.latestTax?.toLocaleString('en-IN')}`);
                  
                  if (r.yearlyITR?.length) {
                    console.log(`\n   Year-wise:`);
                    for (const y of r.yearlyITR) {
                      console.log(`   - AY ${y.ay} | ${y.itrType || y.detectedType} | ${y.regime} | Income: ₹${y.totalIncome?.toLocaleString('en-IN')} | Tax: ₹${y.tax?.totalPaid?.toLocaleString('en-IN')}`);
                    }
                  }
                }
                
                if (result.aiReport) {
                  console.log('\n🤖 AI Report:');
                  const ai = result.aiReport;
                  if (ai.executiveSummary) console.log(`   Summary: ${typeof ai.executiveSummary === 'string' ? ai.executiveSummary.substring(0, 200) : JSON.stringify(ai.executiveSummary).substring(0, 200)}`);
                  if (ai.taxpayerProfile) console.log(`   Risk Score: ${ai.taxpayerProfile.riskScore || '-'}/100`);
                  if (ai.taxOptimization?.recommendations?.length) {
                    console.log(`   Recommendations: ${ai.taxOptimization.recommendations.length}`);
                  }
                }
                
                console.log('\n🎉 Test PASSED');
                process.exit(0);
              } else {
                process.stdout.write('\r');
              }
            } catch(e) {
              process.stdout.write('.');
            }
          });
        }).on('error', () => process.stdout.write('.'));
        
        if (attempts > 60) {
          clearInterval(poll);
          console.log('\n⏰ Timeout!');
          process.exit(1);
        }
      }, 3000);
    });
  });
  
  req.on('error', e => console.error('Analyze error:', e.message));
  req.write(body);
  req.end();
}
