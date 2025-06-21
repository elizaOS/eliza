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

// Fix functions
const fixes = {
  // Fix test timeout arguments in bun:test
  fixBunTestTimeouts: (content) => {
    // Remove second argument from describe/it when using bun:test
    if (content.includes('from \'bun:test\'') || content.includes('from "bun:test"')) {
      // Fix describe with timeout
      content = content.replace(/describe\s*\(\s*(['"`][^'"`]+['"`])\s*,\s*\(\s*\)\s*=>\s*\{([^}]+)\}\s*,\s*\d+\s*\)/g, 
        'describe($1, () => {$2})');
      
      // Fix it with timeout
      content = content.replace(/it\s*\(\s*(['"`][^'"`]+['"`])\s*,\s*async\s*\(\s*\)\s*=>\s*\{([^}]+)\}\s*,\s*\d+\s*\)/g,
        'it($1, async () => {$2})');
    }
    return content;
  },

  // Fix mock function assignments
  fixMockAssignments: (content) => {
    // Fix mockResolvedValue assignment
    content = content.replace(
      /fn\.mockResolvedValue\s*=\s*\(value:\s*any\)\s*=>\s*\{\s*fn\.mockReturnValue\s*=\s*Promise\.resolve\(value\);\s*\};/g,
      'fn.mockResolvedValue = (value: any) => { (fn as any).mockReturnValue(Promise.resolve(value)); };'
    );
    
    // Fix mockReturnValue assignment
    content = content.replace(
      /mockCore\.createUniqueUuid\.mockReturnValue\s*=\s*['"`]([^'"`]+)['"`];/g,
      'mockCore.createUniqueUuid.mockReturnValue(\'$1\');'
    );
    
    return content;
  },

  // Convert vitest imports to bun:test where appropriate
  fixTestImports: (content, filePath) => {
    // Only convert test files, not files that use vi mocking
    if (filePath.endsWith('.test.ts') && !content.includes('vi.mock')) {
      content = content.replace(
        /import\s*\{\s*([^}]+)\s*\}\s*from\s*['"`]vitest['"`];?/g,
        (match, imports) => {
          // Extract what we need from vitest
          const importList = imports.split(',').map(i => i.trim());
          const bunImports = [];
          const vitestImports = [];
          
          importList.forEach(imp => {
            if (['describe', 'it', 'expect', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach'].includes(imp)) {
              bunImports.push(imp);
            } else {
              vitestImports.push(imp);
            }
          });
          
          let result = '';
          if (bunImports.length > 0) {
            result += `import { ${bunImports.join(', ')} } from 'bun:test';`;
          }
          if (vitestImports.length > 0) {
            if (result) result += '\n';
            result += `import { ${vitestImports.join(', ')} } from 'vitest';`;
          }
          return result;
        }
      );
    }
    return content;
  },

  // Fix vi is not defined errors
  fixViImports: (content) => {
    // If file uses vi.mock, ensure vi is imported
    if (content.includes('vi.mock') && !content.includes('import { vi')) {
      // Check if there's already a vitest import
      const vitestImportMatch = content.match(/import\s*\{\s*([^}]+)\s*\}\s*from\s*['"`]vitest['"`];?/);
      if (vitestImportMatch) {
        const imports = vitestImportMatch[1].split(',').map(i => i.trim());
        if (!imports.includes('vi')) {
          content = content.replace(
            vitestImportMatch[0],
            `import { ${imports.join(', ')}, vi } from 'vitest';`
          );
        }
      } else {
        // Add vi import at the top
        content = `import { vi } from 'vitest';\n` + content;
      }
    }
    return content;
  },

  // Fix missing mock functions
  fixMockFunctions: (content) => {
    // Add mockReturnValue function to mocked functions if missing
    if (content.includes('fn.mockReturnValue = ')) {
      content = content.replace(
        /const\s+(\w+)\s*=\s*\{\s*mockReturnValue:\s*undefined\s*\};/g,
        'const $1 = { mockReturnValue: (value: any) => { return value; } };'
      );
    }
    return content;
  }
};

// Files to fix
const filesToFix = [
  {
    path: 'packages/cli/tests/commands/agent.test.ts',
    fixes: [fixes.fixBunTestTimeouts, fixes.fixTestImports]
  },
  {
    path: 'packages/cli/tests/commands/scenario.test.ts',
    fixes: [fixes.fixMockAssignments, fixes.fixViImports, fixes.fixMockFunctions]
  },
  {
    path: 'packages/cli/tests/scenario-runner.unit.test.ts',
    fixes: [fixes.fixViImports]
  },
  {
    path: 'packages/cli/tests/scenario-runner.integration.test.ts',
    fixes: [fixes.fixViImports]
  },
  {
    path: 'packages/cli/tests/unit/scenario-command.test.ts',
    fixes: [fixes.fixViImports]
  },
  {
    path: 'packages/cli/tests/unit/index.test.ts',
    fixes: [fixes.fixViImports]
  },
  {
    path: 'packages/cli/tests/integration/plugin-migrations.test.ts',
    fixes: [fixes.fixBunTestTimeouts]
  }
];

// Process all files
console.log('🔧 Fixing TypeScript and test errors in packages/cli...\n');

for (const file of filesToFix) {
  const fullPath = path.join(process.cwd(), file.path);
  if (fs.existsSync(fullPath)) {
    const fixFunctions = file.fixes.map(f => 
      typeof f === 'string' ? fixes[f] : f
    );
    fixFile(fullPath, fixFunctions);
  } else {
    console.log(`⚠️  File not found: ${file.path}`);
  }
}

console.log(`\n✨ Fixed ${filesFixed} files with ${totalFixes} total fixes`); 