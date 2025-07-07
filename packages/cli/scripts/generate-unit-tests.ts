#!/usr/bin/env bun

import { readdir, readFile, writeFile, stat, mkdir } from 'fs/promises';
import { join, relative, dirname, basename } from 'path';
import { existsSync } from 'fs';
import * as clack from '@clack/prompts';

interface FileToTest {
  sourcePath: string;
  testPath: string;
  category: 'commands' | 'utils' | 'types' | 'other';
}

async function findAllSourceFiles(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = await stat(fullPath);

    if (stats.isDirectory()) {
      if (!entry.includes('node_modules') && !entry.includes('dist') && !entry.includes('test')) {
        await findAllSourceFiles(fullPath, files);
      }
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

function categorizeFile(filePath: string): 'commands' | 'utils' | 'types' | 'other' {
  if (filePath.includes('/commands/')) return 'commands';
  if (filePath.includes('/utils/')) return 'utils';
  if (filePath.includes('/types/')) return 'types';
  return 'other';
}

function getTestPath(sourcePath: string, category: string): string {
  const relativePath = relative(join(process.cwd(), 'src'), sourcePath);
  const testFileName = basename(sourcePath).replace('.ts', '.test.ts');
  const dirPath = dirname(relativePath);

  // Map source directories to test directories
  if (category === 'commands') {
    return join(process.cwd(), 'tests/commands', testFileName);
  } else if (category === 'utils') {
    return join(process.cwd(), 'tests/unit/utils', dirPath.replace('utils/', ''), testFileName);
  } else if (category === 'types') {
    return join(process.cwd(), 'tests/unit/types', testFileName);
  } else {
    return join(process.cwd(), 'tests/unit', relativePath.replace('.ts', '.test.ts'));
  }
}

async function generateTestContent(sourcePath: string): Promise<string> {
  const sourceContent = await readFile(sourcePath, 'utf-8');
  const relativePath = relative(process.cwd(), sourcePath);
  const importPath = relativePath.replace('src/', '../../../src/').replace('.ts', '');

  // Extract exported functions and classes
  const exportMatches = sourceContent.matchAll(/export\s+(async\s+)?function\s+(\w+)/g);
  const classMatches = sourceContent.matchAll(/export\s+class\s+(\w+)/g);
  const constMatches = sourceContent.matchAll(/export\s+const\s+(\w+)/g);

  const functions = Array.from(exportMatches).map((m) => m[2]);
  const classes = Array.from(classMatches).map((m) => m[1]);
  const constants = Array.from(constMatches).map((m) => m[1]);

  let testContent = `import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// TODO: Import the functions/classes to test
// import { ${[...functions, ...classes, ...constants].join(', ')} } from '${importPath}';

describe('${basename(sourcePath).replace('.ts', '')}', () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });
`;

  // Generate test skeletons for functions
  for (const func of functions) {
    testContent += `
  describe('${func}', () => {
    it.todo('should ${func} correctly');
    
    it.todo('should handle errors in ${func}');
  });
`;
  }

  // Generate test skeletons for classes
  for (const cls of classes) {
    testContent += `
  describe('${cls}', () => {
    it.todo('should create instance of ${cls}');
    
    it.todo('should test ${cls} methods');
  });
`;
  }

  // Generate test skeletons for constants
  for (const cnst of constants) {
    testContent += `
  describe('${cnst}', () => {
    it.todo('should export ${cnst} correctly');
  });
`;
  }

  // If no exports found, add a generic test
  if (functions.length === 0 && classes.length === 0 && constants.length === 0) {
    testContent += `
  it.todo('should test module functionality');
`;
  }

  testContent += `});`;

  return testContent;
}

async function main() {
  console.log('🧪 Generating Unit Test Skeletons for elizaOS CLI...\n');

  const srcPath = join(process.cwd(), 'src');
  const sourceFiles = await findAllSourceFiles(srcPath);

  const filesToTest: FileToTest[] = [];
  let skipped = 0;

  for (const sourcePath of sourceFiles) {
    const category = categorizeFile(sourcePath);
    const testPath = getTestPath(sourcePath, category);

    // Skip if test already exists
    if (existsSync(testPath)) {
      skipped++;
      continue;
    }

    filesToTest.push({ sourcePath, testPath, category });
  }

  console.log(`📊 Found ${sourceFiles.length} source files`);
  console.log(`   ${skipped} already have tests`);
  console.log(`   ${filesToTest.length} need test files\n`);

  if (filesToTest.length === 0) {
    console.log('✅ All files already have tests!');
    return;
  }

  console.log('Would you like to generate test skeletons for all untested files?');
  console.log('(This will create .todo tests that you can implement later)\n');

  const shouldGenerateTests = await clack.confirm({
    message: 'Generate test skeletons for all untested files?',
    initialValue: true,
  });

  if (clack.isCancel(shouldGenerateTests)) {
    clack.cancel('Operation cancelled.');
    return;
  }

  if (!shouldGenerateTests) {
    clack.outro('Test generation skipped.');
    return;
  }

  let created = 0;
  let failed = 0;

  for (const file of filesToTest) {
    try {
      // Ensure directory exists
      const testDir = dirname(file.testPath);
      await mkdir(testDir, { recursive: true });

      // Generate test content
      const testContent = await generateTestContent(file.sourcePath);

      // Write test file
      await writeFile(file.testPath, testContent);

      console.log(`✅ Created: ${relative(process.cwd(), file.testPath)}`);
      created++;
    } catch (error) {
      console.error(`❌ Failed: ${relative(process.cwd(), file.testPath)}`);
      console.error(`   Error: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   ✅ Created: ${created} test files`);
  console.log(`   ❌ Failed: ${failed} files`);
  console.log(`\n💡 Next steps:`);
  console.log(`   1. Run 'bun test' to see all .todo tests`);
  console.log(`   2. Implement tests by replacing it.todo with it`);
  console.log(`   3. Run coverage report to track progress`);
}

main().catch(console.error);
