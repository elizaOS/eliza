#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Track fixes
let filesFixed = 0;
let totalFixes = 0;

function fixFile(filePath, fixes) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let originalContent = content;
    let fixCount = 0;

    for (const fix of fixes) {
      const newContent = fix(content, filePath);
      if (newContent !== content) {
        content = newContent;
        fixCount++;
      }
    }

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content);
      console.log(`✅ Fixed ${filePath} (${fixCount} fixes)`);
      filesFixed++;
      totalFixes += fixCount;
      return true;
    }
    return false;
  } catch (error) {
    console.error(`❌ Error fixing ${filePath}:`, error.message);
    return false;
  }
}

// Fix 1: Remove unused imports
function removeUnusedImports(content, filePath) {
  // For agent.test.ts - remove beforeEach and afterEach
  if (filePath.includes('tests/commands/agent.test.ts')) {
    return content.replace(
      /import\s*{\s*describe,\s*it,\s*expect,\s*beforeAll,\s*afterAll,\s*beforeEach,\s*afterEach\s*}\s*from\s*'vitest';/,
      "import { describe, it, expect, beforeAll, afterAll } from 'vitest';"
    );
  }
  
  // For create.test.ts - remove afterAll and beforeEach
  if (filePath.includes('tests/commands/create.test.ts')) {
    return content.replace(
      /import\s*{\s*describe,\s*it,\s*expect,\s*beforeAll,\s*afterAll,\s*beforeEach,\s*afterEach\s*}\s*from\s*'vitest';/,
      "import { describe, it, expect, beforeAll, afterEach } from 'vitest';"
    );
  }
  
  return content;
}

// Fix 2: Add types to implicit any parameters
function addParameterTypes(content, filePath) {
  let newContent = content;
  
  // Fix mockImplementation callbacks with implicit any
  newContent = newContent.replace(
    /\.mockImplementation\(async \((\w+)\) => {/g,
    '.mockImplementation(async ($1: any) => {'
  );
  
  newContent = newContent.replace(
    /\.mockImplementation\(\((\w+)\) => {/g,
    '.mockImplementation(($1: any) => {'
  );
  
  return newContent;
}

// Files to fix
const filesToFix = [
  'packages/cli/tests/commands/agent.test.ts',
  'packages/cli/tests/commands/create.test.ts',
  'packages/cli/tests/unit/scenario-command.test.ts',
  'packages/cli/tests/unit/utils/build-project.test.ts',
  'packages/cli/tests/unit/utils/directory-detection.test.ts'
];

const fixes = [removeUnusedImports, addParameterTypes];

console.log('🔧 Fixing final TypeScript errors in packages/cli...\n');

// Apply fixes
for (const file of filesToFix) {
  fixFile(file, fixes);
}

console.log(`\n✨ Fixed ${filesFixed} files with ${totalFixes} total fixes`); 