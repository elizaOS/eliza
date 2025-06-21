#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Track fixes
let filesFixed = 0;
let totalFixes = 0;

function fixVitestImports(content, filePath) {
  let newContent = content;
  let fixes = 0;

  // Check if file uses vi.mock or other vi functions
  if (content.includes('vi.mock') || content.includes('vi.fn') || content.includes('vi.importActual')) {
    // Check if vi is already imported
    if (!content.includes("import { vi") && !content.includes("import {vi") && !content.includes("import{vi")) {
      // Find existing vitest import
      const vitestImportMatch = content.match(/import\s*{\s*([^}]+)\s*}\s*from\s*['"]vitest['"]/);
      
      if (vitestImportMatch) {
        // Add vi to existing import
        const imports = vitestImportMatch[1].split(',').map(s => s.trim());
        if (!imports.includes('vi')) {
          imports.push('vi');
          const newImport = `import { ${imports.join(', ')} } from 'vitest'`;
          newContent = newContent.replace(vitestImportMatch[0], newImport);
          fixes++;
        }
      } else {
        // Add new import at the top
        const lines = newContent.split('\n');
        let insertIndex = 0;
        
        // Find the right place to insert (after other imports)
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('import ')) {
            insertIndex = i + 1;
          } else if (lines[i].trim() !== '' && !lines[i].startsWith('import ')) {
            break;
          }
        }
        
        lines.splice(insertIndex, 0, "import { vi } from 'vitest';");
        newContent = lines.join('\n');
        fixes++;
      }
    }
  }

  return { content: newContent, fixes };
}

// Find all test files in packages/cli
const testFiles = glob.sync('packages/cli/**/*.test.ts', {
  ignore: ['**/node_modules/**', '**/dist/**']
});

console.log(`🔧 Fixing vitest imports in ${testFiles.length} test files...`);

for (const file of testFiles) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const { content: newContent, fixes } = fixVitestImports(content, file);
    
    if (fixes > 0) {
      fs.writeFileSync(file, newContent);
      console.log(`✅ Fixed ${file} (${fixes} fixes)`);
      filesFixed++;
      totalFixes += fixes;
    }
  } catch (error) {
    console.error(`❌ Error fixing ${file}:`, error.message);
  }
}

console.log(`\n✨ Fixed ${filesFixed} files with ${totalFixes} total fixes`); 