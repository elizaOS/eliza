#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

async function main() {
  // Find all test files
  const testFiles = await glob('tests/**/*.test.ts', {
    cwd: process.cwd(),
    absolute: true
  });

  console.log(`Found ${testFiles.length} test files to convert`);

  testFiles.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let modified = false;
    
    // Replace Jest imports with Vitest imports
    if (content.includes('@jest/globals')) {
      content = content.replace(
        /from '@jest\/globals'/g,
        "from 'vitest'"
      );
      modified = true;
    }
    
    if (content.includes("from 'jest'")) {
      content = content.replace(
        /from 'jest'/g,
        "from 'vitest'"
      );
      modified = true;
    }
    
    // Replace jest. function calls with vi. function calls
    if (content.includes('jest.')) {
      content = content.replace(/\bjest\./g, 'vi.');
      modified = true;
    }
    
    // Ensure vi is imported if jest was used
    if (modified && content.includes('vi.') && !content.includes('vi,')) {
      // Add vi to the imports if it's not already there
      content = content.replace(
        /import \{([^}]+)\} from 'vitest'/,
        (match, imports) => {
          const importList = imports.split(',').map(i => i.trim());
          if (!importList.includes('vi')) {
            importList.push('vi');
          }
          return `import { ${importList.join(', ')} } from 'vitest'`;
        }
      );
    }
    
    if (modified) {
      fs.writeFileSync(file, content);
      console.log(`✅ Converted: ${path.relative(process.cwd(), file)}`);
    } else {
      console.log(`⏭️  Skipped: ${path.relative(process.cwd(), file)} (no Jest imports found)`);
    }
  });

  console.log('\nConversion complete!');
}

main().catch(console.error); 