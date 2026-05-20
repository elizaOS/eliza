#!/usr/bin/env bun

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

type OutputFormat = 'text' | 'json';

export type EnvAuditReport = {
  declared: string[];
  runtime: string[];
  testOnly: string[];
  platform: string[];
  usedButUndeclaredRuntime: string[];
  declaredButUnusedRuntime: string[];
  dynamicAccesses: Array<{ file: string; sample: string }>;
  totals: {
    declared: number;
    runtime: number;
    testOnly: number;
    platform: number;
    usedButUndeclaredRuntime: number;
    declaredButUnusedRuntime: number;
    dynamicAccesses: number;
  };
};

type EnvReferenceScanResult = {
  keys: Set<string>;
  dynamicAccesses: Array<{ file: string; sample: string }>;
};

const SOURCE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.turbo',
  '.vercel',
  '.next',
  '.output',
  'dist',
  'build',
  'coverage',
]);

const PLATFORM_PREFIXES = ['VERCEL_', 'TURBO_', 'NX_'];

const PLATFORM_KEYS = new Set([
  'CI',
  'NODE_ENV',
  'BUN_ENV',
  'VERCEL',
  'NEXT_PHASE',
  'NEXT_RUNTIME',
  'PWD',
  'PATH',
  'HOME',
  'HOSTNAME',
  'SHLVL',
]);

const RUNTIME_EXCLUDED_PATH_PARTS = [
  join('apps', 'docs'),
  join('packages', 'testing'),
  join('packages', 'examples'),
];

function isSourceFile(filePath: string): boolean {
  for (const ext of SOURCE_FILE_EXTENSIONS) {
    if (filePath.endsWith(ext)) return true;
  }
  return false;
}

export function isTestFilePath(filePath: string): boolean {
  if (filePath.includes('/__tests__/')) return true;
  if (filePath.includes('/tests/')) return true;
  if (filePath.endsWith('.test.ts')) return true;
  if (filePath.endsWith('.test.tsx')) return true;
  if (filePath.endsWith('.test.js')) return true;
  if (filePath.endsWith('.test.jsx')) return true;
  if (filePath.endsWith('.spec.ts')) return true;
  if (filePath.endsWith('.spec.tsx')) return true;
  if (filePath.endsWith('.spec.js')) return true;
  if (filePath.endsWith('.spec.jsx')) return true;
  return filePath.startsWith(join('packages', 'testing') + '/');
}

export function isRuntimeFilePath(filePath: string): boolean {
  if (!isSourceFile(filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  if (filePath.endsWith('.md')) return false;
  if (isTestFilePath(filePath)) return false;
  for (const part of RUNTIME_EXCLUDED_PATH_PARTS) {
    if (filePath.startsWith(part + '/')) return false;
  }
  return (
    filePath.startsWith('apps/') ||
    filePath.startsWith('packages/') ||
    filePath.startsWith('scripts/')
  );
}

function walkFiles(rootDir: string, subPath: string): string[] {
  const absPath = join(rootDir, subPath);
  if (!existsSync(absPath)) return [];

  const entries = readdirSync(absPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith('.next')) continue;
      files.push(...walkFiles(rootDir, join(subPath, entry.name)));
      continue;
    }

    if (!entry.isFile()) continue;
    const rel = join(subPath, entry.name);
    if (!isSourceFile(rel)) continue;
    files.push(rel);
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export function extractProcessEnvKeysFromText(text: string): {
  keys: string[];
  hasDynamicAccess: boolean;
  dynamicSample: string | null;
} {
  const keys = new Set<string>();

  const dotRegex = /process\.env\.([A-Z0-9_]+)/g;
  for (const match of text.matchAll(dotRegex)) {
    const key = match[1];
    if (key) keys.add(key);
  }

  const bracketLiteralRegex = /process\.env\[['"]([A-Z0-9_]+)['"]\]/g;
  for (const match of text.matchAll(bracketLiteralRegex)) {
    const key = match[1];
    if (key) keys.add(key);
  }

  // Detect dynamic access like `process.env[name]` (not a string literal).
  // This is informational only: we can't enumerate keys reliably.
  const bracketAnyRegex = /process\.env\[(?<inner>[^\]]+)\]/g;
  let hasDynamicAccess = false;
  let dynamicSample: string | null = null;
  for (const match of text.matchAll(bracketAnyRegex)) {
    const inner = match.groups?.inner?.trim() ?? '';
    if (!inner) continue;
    const isLiteral = inner.startsWith("'") || inner.startsWith('"');
    if (!isLiteral) {
      hasDynamicAccess = true;
      dynamicSample = match[0].slice(0, 120);
      break;
    }
  }

  return {
    keys: Array.from(keys).sort((a, b) => a.localeCompare(b)),
    hasDynamicAccess,
    dynamicSample,
  };
}

export function extractEnvExampleKeysFromText(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const delimiterIndex = trimmed.indexOf('=');
    if (delimiterIndex <= 0) continue;

    const key = trimmed.slice(0, delimiterIndex).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;

    keys.add(key);
  }

  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function isPlatformKey(key: string): boolean {
  if (PLATFORM_KEYS.has(key)) return true;
  for (const prefix of PLATFORM_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  if (key.startsWith('NEXT_PUBLIC_VERCEL_')) return true;
  if (key.startsWith('VERCEL_')) return true;
  return false;
}

function scanFiles(
  rootDir: string,
  filePaths: string[]
): EnvReferenceScanResult {
  const keys = new Set<string>();
  const dynamicAccesses: Array<{ file: string; sample: string }> = [];

  for (const filePath of filePaths) {
    const abs = join(rootDir, filePath);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile()) continue;

    const text = readFileSync(abs, 'utf8');
    const extracted = extractProcessEnvKeysFromText(text);
    for (const key of extracted.keys) keys.add(key);
    if (extracted.hasDynamicAccess && extracted.dynamicSample) {
      dynamicAccesses.push({ file: filePath, sample: extracted.dynamicSample });
    }
  }

  dynamicAccesses.sort((a, b) => a.file.localeCompare(b.file));
  return { keys, dynamicAccesses };
}

function buildReport(params: {
  declaredKeys: string[];
  runtimeKeys: Set<string>;
  testKeys: Set<string>;
  dynamicAccesses: Array<{ file: string; sample: string }>;
}): EnvAuditReport {
  const declared = new Set(params.declaredKeys);

  const runtime = Array.from(params.runtimeKeys).sort((a, b) =>
    a.localeCompare(b)
  );
  const testOnly = Array.from(params.testKeys)
    .filter((key) => !params.runtimeKeys.has(key))
    .sort((a, b) => a.localeCompare(b));

  const platform = runtime.filter(isPlatformKey);

  const usedButUndeclaredRuntime = runtime
    .filter((key) => !isPlatformKey(key))
    .filter((key) => !declared.has(key));

  const declaredButUnusedRuntime = params.declaredKeys.filter(
    (key) => !params.runtimeKeys.has(key)
  );

  return {
    declared: params.declaredKeys,
    runtime,
    testOnly,
    platform,
    usedButUndeclaredRuntime,
    declaredButUnusedRuntime,
    dynamicAccesses: params.dynamicAccesses,
    totals: {
      declared: params.declaredKeys.length,
      runtime: runtime.length,
      testOnly: testOnly.length,
      platform: platform.length,
      usedButUndeclaredRuntime: usedButUndeclaredRuntime.length,
      declaredButUnusedRuntime: declaredButUnusedRuntime.length,
      dynamicAccesses: params.dynamicAccesses.length,
    },
  };
}

function printTextReport(report: EnvAuditReport): void {
  console.log('Env audit report');
  console.log(`- declared (.env.example): ${report.totals.declared}`);
  console.log(`- runtime used (TS/JS): ${report.totals.runtime}`);
  console.log(`- test-only used: ${report.totals.testOnly}`);
  console.log(`- platform/runtime allowlist: ${report.totals.platform}`);
  console.log(
    `- used but undeclared (runtime): ${report.totals.usedButUndeclaredRuntime}`
  );
  console.log(
    `- declared but unused (runtime): ${report.totals.declaredButUnusedRuntime}`
  );
  console.log(`- dynamic env accesses: ${report.totals.dynamicAccesses}`);

  if (report.usedButUndeclaredRuntime.length > 0) {
    console.log('');
    console.log('Used but undeclared (runtime):');
    for (const key of report.usedButUndeclaredRuntime) {
      console.log(`- ${key}`);
    }
  }

  if (report.dynamicAccesses.length > 0) {
    console.log('');
    console.log('Dynamic env accesses (cannot enumerate keys reliably):');
    const preview = report.dynamicAccesses.slice(0, 20);
    for (const item of preview) {
      console.log(`- ${item.file}: ${item.sample}`);
    }
    if (report.dynamicAccesses.length > preview.length) {
      console.log(
        `- ...and ${report.dynamicAccesses.length - preview.length} more`
      );
    }
  }
}

function printHelp(): void {
  console.log(
    'Usage: bun run env:audit [--check] [--format=json|text] [--out=<file>]'
  );
  console.log('');
  console.log('Options:');
  console.log(
    '- --check: exit non-zero if runtime-owned keys are used but not declared in .env.example'
  );
  console.log('- --format=json|text: output format (default: text)');
  console.log('- --out=<file>: write output to file instead of stdout');
}

function parseArgs(argv: string[]): {
  check: boolean;
  format: OutputFormat;
  outFile: string | null;
  help: boolean;
} {
  let check = false;
  let format: OutputFormat = 'text';
  let outFile: string | null = null;
  let help = false;

  for (const arg of argv) {
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length).trim() as OutputFormat;
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Invalid --format value "${value}"`);
      }
      format = value;
      continue;
    }
    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length).trim();
      if (!value) throw new Error('Invalid --out value');
      outFile = value;
      continue;
    }
    throw new Error(`Unknown argument "${arg}"`);
  }

  return { check, format, outFile, help };
}

export function runCli(rootDir: string, argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const absRoot = resolve(rootDir);
  const envExamplePath = join(absRoot, '.env.example');
  if (!existsSync(envExamplePath)) {
    throw new Error('Missing .env.example at repo root');
  }

  const declaredKeys = extractEnvExampleKeysFromText(
    readFileSync(envExamplePath, 'utf8')
  );

  const allFiles = [
    ...walkFiles(absRoot, 'apps'),
    ...walkFiles(absRoot, 'packages'),
    ...walkFiles(absRoot, 'scripts'),
  ];

  const runtimeFiles = allFiles.filter(isRuntimeFilePath);
  const testFiles = allFiles.filter(isTestFilePath);

  const runtimeScan = scanFiles(absRoot, runtimeFiles);
  const testScan = scanFiles(absRoot, testFiles);

  const report = buildReport({
    declaredKeys,
    runtimeKeys: runtimeScan.keys,
    testKeys: testScan.keys,
    dynamicAccesses: runtimeScan.dynamicAccesses,
  });

  const output =
    args.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : null;

  if (args.outFile) {
    const outPath = resolve(absRoot, args.outFile);
    if (output) {
      writeFileSync(outPath, output);
    } else {
      // For text output, reuse the same stdout rendering to a file.
      // Keep the file deterministic by writing a JSON representation instead.
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    }
  } else {
    if (args.format === 'json') {
      process.stdout.write(output!);
    } else {
      printTextReport(report);
    }
  }

  if (args.check && report.usedButUndeclaredRuntime.length > 0) {
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  try {
    const exitCode = runCli(process.cwd(), process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
}
