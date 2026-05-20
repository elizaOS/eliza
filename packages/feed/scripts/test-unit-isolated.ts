/**
 * Isolated Unit Test Runner
 *
 * Runs each unit test file in its own bun subprocess so mock.module()
 * calls in one file cannot leak into another. Bun's test runner shares
 * a single module registry across all files in a single invocation,
 * which means mock.module('@feed/shared', ...) in file A replaces
 * the real module for file B too. This script works around that by
 * spawning a separate `bun test <file>` for each test file.
 *
 * Runs up to CONCURRENCY files at a time to speed up large suites while
 * keeping process isolation.
 */

import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const TEST_DIRS = [
  join(ROOT, 'packages/testing/unit'),
  join(ROOT, 'scripts'),
  join(ROOT, 'packages/engine/src'),
  join(ROOT, 'packages/core'),
  join(ROOT, 'packages/api/src'),
  join(ROOT, 'packages/agents/src'),
  join(ROOT, 'packages/sim'),
  join(ROOT, 'packages/training/src'),
  join(ROOT, 'packages/db/src'),
  join(ROOT, 'packages/shared/src'),
  join(ROOT, 'apps/web/src'),
];
const PRELOAD = join(ROOT, 'packages/testing/unit/preload.ts');

/** Directories to skip when collecting test files */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'e2e',
  'synpress',
  'performance',
]);

/**
 * Tests excluded from the unit runner because they require infrastructure
 * not available in the unit test environment. Integration tests that need
 * DB/API should use the .integration.test.ts suffix instead.
 */
const EXCLUDED_FILES = new Set([
  // Need real database (already in integration/ dirs, kept as safety net)
  'packages/engine/src/__tests__/integration/engine-components-validation.test.ts',
  'packages/engine/src/__tests__/integration/game-quality.test.ts',
  'packages/engine/src/__tests__/security/no-cheating.test.ts',
  'packages/engine/src/__tests__/integration/npc-voice-diversity.test.ts',
  // Queries ActorState table — requires a running database
  'packages/testing/unit/actor-context-builder.test.ts',
  // Missing fixture files (need `bun run packages/training/scripts/generate-benchmark-scenarios.ts`)
  'packages/training/src/benchmark/__tests__/ScenarioLoader.test.ts',
]);
// Make concurrency configurable via env var, with a sensible default
const CONCURRENCY = Number(process.env.TEST_CONCURRENCY) || 4;

export function collectTestFiles(dir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(full));
    } else if (
      (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) &&
      !entry.name.endsWith('.integration.test.ts') &&
      !entry.name.endsWith('.e2e.test.ts')
    ) {
      const rel = relative(ROOT, full);
      if (!EXCLUDED_FILES.has(rel)) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

async function runOne(
  file: string
): Promise<{ rel: string; exitCode: number; stdout: string; stderr: string }> {
  const rel = relative(ROOT, file);
  const proc = Bun.spawn(['bun', 'test', file, '--preload', PRELOAD], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Bun's runtime transpiler cache can serve stale test/module code under
      // parallel isolated runs, which produces false failures in the unit suite.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { rel, exitCode, stdout, stderr };
}

async function main() {
  const testFiles = TEST_DIRS.flatMap(collectTestFiles).sort();
  console.log(
    `Running ${testFiles.length} test files in isolated subprocesses (concurrency ${CONCURRENCY})...\n`
  );

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (let i = 0; i < testFiles.length; i += CONCURRENCY) {
    const chunk = testFiles.slice(i, i + CONCURRENCY);
    // Note: using Promise.allSettled for parallel execution, ensuring one test failure doesn't prevent others from running
    const settled = await Promise.allSettled(chunk.map(runOne));
    const results = settled.map((result) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            rel: 'unknown',
            exitCode: 1,
            stdout: '',
            stderr: `Test failed to execute: ${result.reason}`,
          }
    );

    for (const { rel, exitCode, stdout, stderr } of results) {
      if (exitCode === 0) {
        const match = stdout.match(/(\d+) pass/);
        const count = match ? match[1] : '?';
        console.log(`  ✓ ${rel} (${count} pass)`);
        passed++;
      } else {
        console.log(`  ✗ ${rel}`);
        const failLines = (stdout + stderr)
          .split('\n')
          .filter(
            (l) =>
              l.includes('(fail)') ||
              l.includes('error:') ||
              l.includes('Error:')
          )
          .slice(0, 8);
        for (const line of failLines) {
          console.log(`    ${line.trim()}`);
        }
        failed++;
        failures.push(rel);
      }
    }
  }

  console.log(`\n${passed} files passed, ${failed} files failed`);
  if (failures.length > 0) {
    console.log('\nFailed files:');
    for (const f of failures) console.log(`  - ${f}`);
    // Note: exits with code 1 to clearly indicate test failures after logging results
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Error running isolated unit tests:', err);
    process.exit(1);
  });
}
