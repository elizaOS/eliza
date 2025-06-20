#!/usr/bin/env bun

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative } from 'path';

interface CoverageReport {
  totalFiles: number;
  testedFiles: number;
  untestedFiles: string[];
  coverage: number;
  byCategory: {
    commands: { total: number; tested: number; untested: string[] };
    utils: { total: number; tested: number; untested: string[] };
    types: { total: number; tested: number; untested: string[] };
    other: { total: number; tested: number; untested: string[] };
  };
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

async function findAllTestFiles(dir: string, files: string[] = []): Promise<string[]> {
  try {
    const entries = await readdir(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stats = await stat(fullPath);

      if (stats.isDirectory()) {
        await findAllTestFiles(fullPath, files);
      } else if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    // Directory might not exist
  }

  return files;
}

function categorizeFile(filePath: string): 'commands' | 'utils' | 'types' | 'other' {
  if (filePath.includes('/commands/')) return 'commands';
  if (filePath.includes('/utils/')) return 'utils';
  if (filePath.includes('/types/')) return 'types';
  return 'other';
}

async function generateCoverageReport(): Promise<CoverageReport> {
  const srcPath = join(process.cwd(), 'src');
  const testsPath = join(process.cwd(), 'tests');

  // Find all source files
  const sourceFiles = await findAllSourceFiles(srcPath);

  // Find all test files
  const testFiles = await findAllTestFiles(testsPath);

  // Extract tested files from test file names and imports
  const testedFiles = new Set<string>();

  for (const testFile of testFiles) {
    const content = await readFile(testFile, 'utf-8');

    // Extract imports to find which files are being tested
    const importMatches = content.matchAll(/from\s+['"](.+?)['"]/g);
    for (const match of importMatches) {
      const importPath = match[1];
      if (importPath.startsWith('../') || importPath.startsWith('./')) {
        // Resolve relative import
        const resolvedPath = importPath
          .replace(/^\.\.\/\.\.\/\.\.\/src/, srcPath)
          .replace(/^\.\.\/\.\.\/src/, srcPath)
          .replace(/^\.\//, '');
        testedFiles.add(resolvedPath);
      }
    }

    // Also check based on test file naming convention
    const testName = relative(testsPath, testFile).replace('.test.ts', '').replace('.spec.ts', '');
    const possibleSourceFile = join(srcPath, testName + '.ts');
    testedFiles.add(possibleSourceFile);
  }

  // Categorize files
  const report: CoverageReport = {
    totalFiles: sourceFiles.length,
    testedFiles: 0,
    untestedFiles: [],
    coverage: 0,
    byCategory: {
      commands: { total: 0, tested: 0, untested: [] },
      utils: { total: 0, tested: 0, untested: [] },
      types: { total: 0, tested: 0, untested: [] },
      other: { total: 0, tested: 0, untested: [] },
    },
  };

  // Analyze each source file
  for (const sourceFile of sourceFiles) {
    const category = categorizeFile(sourceFile);
    const relativePath = relative(srcPath, sourceFile);
    const hasTest = Array.from(testedFiles).some(
      (tested) => tested.includes(relativePath.replace('.ts', '')) || sourceFile.includes(tested)
    );

    report.byCategory[category].total++;

    if (hasTest) {
      report.testedFiles++;
      report.byCategory[category].tested++;
    } else {
      report.untestedFiles.push(relativePath);
      report.byCategory[category].untested.push(relativePath);
    }
  }

  report.coverage = (report.testedFiles / report.totalFiles) * 100;

  return report;
}

async function main() {
  console.log('🔍 Analyzing Unit Test Coverage for elizaOS CLI...\n');

  const report = await generateCoverageReport();

  console.log(`📊 Overall Coverage: ${report.coverage.toFixed(1)}%`);
  console.log(`   Total Files: ${report.totalFiles}`);
  console.log(`   Tested Files: ${report.testedFiles}`);
  console.log(`   Untested Files: ${report.untestedFiles.length}\n`);

  // Category breakdown
  console.log('📁 Coverage by Category:');
  for (const [category, data] of Object.entries(report.byCategory)) {
    const coverage = data.total > 0 ? ((data.tested / data.total) * 100).toFixed(1) : '0.0';
    console.log(`\n   ${category.toUpperCase()}: ${coverage}% (${data.tested}/${data.total})`);

    if (data.untested.length > 0 && data.untested.length <= 10) {
      console.log('   Untested files:');
      data.untested.forEach((file) => console.log(`     - ${file}`));
    } else if (data.untested.length > 10) {
      console.log(`   Untested files: ${data.untested.length} files`);
      console.log('   First 10:');
      data.untested.slice(0, 10).forEach((file) => console.log(`     - ${file}`));
    }
  }

  console.log('\n📝 Summary:');
  if (report.coverage === 100) {
    console.log('   ✅ Congratulations! You have achieved 100% unit test coverage!');
  } else {
    console.log(
      `   ⚠️  ${report.untestedFiles.length} files still need unit tests to reach 100% coverage.`
    );
    console.log('\n   Priority files to test:');

    // Prioritize by importance
    const priorityFiles = report.untestedFiles
      .filter((f) => f.includes('index.ts') || f.includes('main.ts'))
      .slice(0, 5);

    if (priorityFiles.length > 0) {
      priorityFiles.forEach((file) => console.log(`     - ${file}`));
    } else {
      report.untestedFiles.slice(0, 5).forEach((file) => console.log(`     - ${file}`));
    }
  }

  // Save detailed report
  const detailedReport = JSON.stringify(report, null, 2);
  await Bun.write('unit-test-coverage-report.json', detailedReport);
  console.log('\n💾 Detailed report saved to: unit-test-coverage-report.json');
}

main().catch(console.error);
