#!/usr/bin/env node

const { execSync } = require('child_process');

// Get all TypeScript errors
let output;
try {
  output = execSync('npx tsc --noEmit 2>&1', { encoding: 'utf-8' }).trim();
} catch (err) {
  // TypeScript exits with non-zero when there are errors
  output = err.stdout || err.output?.[1] || '';
}

const lines = output.split('\n').filter(line => line.includes('error TS'));

// Parse errors
const errors = lines.map(line => {
  const match = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/);
  if (!match) return null;
  
  const [, file, lineNum, colNum, code, message] = match;
  return { file, line: parseInt(lineNum), col: parseInt(colNum), code, message };
}).filter(Boolean);

// Group by error type
const errorTypes = {};

errors.forEach(error => {
  if (!errorTypes[error.code]) {
    errorTypes[error.code] = [];
  }
  errorTypes[error.code].push(error);
});

// Summary
console.log('TypeScript Error Summary');
console.log('========================');
console.log(`Total errors: ${errors.length}`);
console.log('\nError breakdown:');

const descriptions = {
  TS6133: 'Unused variables/parameters',
  TS6196: 'Unused imports',
  TS2339: 'Property does not exist',
  TS2717: 'Duplicate property declarations',
  TS2348: 'Value not callable',
  TS2322: 'Type mismatch',
  TS2305: 'Module has no exported member',
  TS2345: 'Argument type mismatch',
  TS2353: 'Unknown property in object literal',
  TS2551: 'Property name typo',
};

// Sort by count
const sortedErrors = Object.entries(errorTypes).sort((a, b) => b[1].length - a[1].length);

sortedErrors.forEach(([code, instances]) => {
  console.log(`\n${code} - ${descriptions[code] || 'Other'}: ${instances.length} errors`);
  
  // Group by file
  const byFile = {};
  instances.forEach(err => {
    if (!byFile[err.file]) byFile[err.file] = [];
    byFile[err.file].push(err);
  });
  
  Object.entries(byFile).forEach(([file, errs]) => {
    console.log(`  ${file}: ${errs.length} errors`);
  });
}); 