#!/usr/bin/env bun

import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

async function convertTestFiles() {
  const testsDir = join(process.cwd(), 'tests', 'commands');
  const files = await readdir(testsDir);
  
  for (const file of files) {
    if (file.endsWith('.test.ts')) {
      const filePath = join(testsDir, file);
      let content = await readFile(filePath, 'utf-8');
      
      // Replace bun:test imports with vitest
      content = content.replace(
        /import\s*{\s*([^}]+)\s*}\s*from\s*['"]bun:test['"]/g,
        (match, imports) => {
          // Handle test -> it conversion
          const updatedImports = imports.replace(/\btest\b/g, 'it');
          return `import { ${updatedImports} } from 'vitest'`;
        }
      );
      
      // Replace all occurrences of test( with it(
      content = content.replace(/\btest\(/g, 'it(');
      
      // Add vi import if the file uses mocks (checking for common mock patterns)
      if (content.includes('execSync') || content.includes('spawn') || content.includes('mock')) {
        const vitestImport = content.match(/import\s*{([^}]+)}\s*from\s*['"]vitest['"]/);
        if (vitestImport && !vitestImport[1].includes('vi')) {
          content = content.replace(
            /import\s*{([^}]+)}\s*from\s*['"]vitest['"]/,
            (match, imports) => `import {${imports}, vi } from 'vitest'`
          );
        }
      }
      
      await writeFile(filePath, content);
      console.log(`✅ Converted ${file}`);
    }
  }
}

convertTestFiles().catch(console.error); 