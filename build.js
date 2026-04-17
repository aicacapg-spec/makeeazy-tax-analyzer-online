// build.js — Obfuscate and minify frontend code for production
const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'public');
const DIST_DIR = path.join(__dirname, 'public-dist');

// Ensure dist dir
if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

// 1. Obfuscate app.js
console.log('🔒 Obfuscating app.js...');
const appJs = fs.readFileSync(path.join(SRC_DIR, 'app.js'), 'utf8');
const obfuscated = JavaScriptObfuscator.obfuscate(appJs, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  debugProtection: true,
  debugProtectionInterval: 2000,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false
});
fs.writeFileSync(path.join(DIST_DIR, 'app.js'), obfuscated.getObfuscatedCode());
console.log('  ✅ app.js obfuscated');

// 2. Minify CSS
console.log('🎨 Minifying style.css...');
let css = fs.readFileSync(path.join(SRC_DIR, 'style.css'), 'utf8');
css = css
  .replace(/\/\*[\s\S]*?\*\//g, '')     // remove comments
  .replace(/\s+/g, ' ')                  // collapse whitespace
  .replace(/\s*([{}:;,>~+])\s*/g, '$1')  // remove spaces around selectors
  .replace(/;}/g, '}')                    // remove last semicolon
  .trim();
fs.writeFileSync(path.join(DIST_DIR, 'style.css'), css);
console.log('  ✅ style.css minified');

// 3. Copy and protect index.html
console.log('📄 Processing index.html...');
let html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');

// Add anti-devtools protection script before </body>
const protectionScript = `
<script>
// Anti right-click
document.addEventListener('contextmenu',function(e){e.preventDefault();});
// Anti keyboard shortcuts (F12, Ctrl+Shift+I/J/C, Ctrl+U)
document.addEventListener('keydown',function(e){
  if(e.key==='F12')e.preventDefault();
  if(e.ctrlKey&&e.shiftKey&&['I','J','C'].includes(e.key))e.preventDefault();
  if(e.ctrlKey&&e.key==='u')e.preventDefault();
  if(e.ctrlKey&&e.key==='s')e.preventDefault();
});
// Anti text selection on body
document.body.style.userSelect='none';
document.body.style.webkitUserSelect='none';
// Allow selection inside input/textarea
document.querySelectorAll('input,textarea').forEach(function(el){el.style.userSelect='text';el.style.webkitUserSelect='text';});
</script>`;

html = html.replace('</body>', protectionScript + '\n</body>');
// Minify HTML
html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s*\n/g, '\n').trim();
fs.writeFileSync(path.join(DIST_DIR, 'index.html'), html);
console.log('  ✅ index.html protected & minified');

// 4. Copy other static files
const staticFiles = ['makeeazy-logo.png', 'icon.png'];
for (const f of staticFiles) {
  const src = path.join(SRC_DIR, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST_DIR, f));
    console.log(`  📁 Copied ${f}`);
  }
}

// Stats
const origSize = fs.statSync(path.join(SRC_DIR, 'app.js')).size;
const obfSize = fs.statSync(path.join(DIST_DIR, 'app.js')).size;
const origCss = fs.statSync(path.join(SRC_DIR, 'style.css')).size;
const minCss = fs.statSync(path.join(DIST_DIR, 'style.css')).size;

console.log('\n📊 Results:');
console.log(`  app.js:    ${(origSize/1024).toFixed(1)}KB → ${(obfSize/1024).toFixed(1)}KB (obfuscated)`);
console.log(`  style.css: ${(origCss/1024).toFixed(1)}KB → ${(minCss/1024).toFixed(1)}KB (minified)`);
console.log('\n🚀 Production files ready in public-dist/');
