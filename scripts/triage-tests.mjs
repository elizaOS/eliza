#!/usr/bin/env node
/**
 * triage-tests.mjs — Phase 3 of the elizaOS test-stack overhaul.
 *
 * Walks every test file under the repo (excluding vendored/build dirs) and
 * classifies each as KEEP / DELETE / CONVERT based on imports and content
 * signals. Writes coverage-matrix.csv at repo root and
 * scripts/triage-tests.summary.md.
 *
 * Read-only with respect to test files. The only writes are the two outputs
 * listed above.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  ".git",
  ".cache",
  "target",
  ".benchmark-logs",
  "build",
  "tsbuild",
  ".next",
  ".vite",
  ".parcel-cache",
  ".bun",
]);

const SKIP_PATH_FRAGMENTS = [
  path.sep + ".claude" + path.sep + "worktrees" + path.sep,
];

const TEST_EXTS = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

const HEAD_BYTES = 8 * 1024;
const SIZE_WARN_LIMIT = 200 * 1024;

const RUNTIME_IMPORT_PATTERNS = [
  /\bAgentRuntime\b/,
  /\bcreateRuntime\b/,
  /\bbuildPgliteAdapter\b/,
  /\bMockRuntime\b/,
  /\bcreateMockedTestRuntime\b/,
];

const MOCKOON_PATTERNS = [
  /\bstartMocks\b/,
  /['"]mockoon['"]/,
  /\bMOCKOON_/,
  /['"][^'"\n]*test\/mocks\/scripts\/start-mocks/,
  /['"][^'"\n]*test\/helpers\/live-provider/,
];

const REAL_API_PATTERNS = [
  /process\.env\.[A-Z][A-Z0-9_]*_API_KEY\b/,
  /\bapi\.openai\.com\b/,
  /\bapi\.anthropic\.com\b/,
  /\bskipIfNoLiveCredentials\b/,
  /\brequireLiveProvider\b/,
];

const PLAYWRIGHT_PATTERNS = [
  /['"]playwright['"]/,
  /['"]@playwright\/test['"]/,
  /['"]puppeteer['"]/,
  /['"]puppeteer-core['"]/,
];

const BROWSER_INFRA_PATTERNS = [
  /\bhttp\.createServer\s*\(/,
  /\bBun\.serve\s*\(/,
  /\bfastify\s*\(/,
  /\bexpress\s*\(/,
];

const SPAWN_PATTERNS = [
  /['"]child_process['"]/,
  /['"]node:child_process['"]/,
  /\bspawn\s*\(/,
  /\bspawnSync\s*\(/,
  /\bexecSync\s*\(/,
  /\bBun\.spawn\s*\(/,
];

const VI_MOCK_PATTERNS = [
  /\bvi\.fn\s*\(/g,
  /\bvi\.mock\s*\(/g,
  /\bvi\.spyOn\s*\(/g,
  /\bmock\.module\s*\(/g,
];

const JEST_MOCK_PATTERNS = [
  /\bjest\.fn\s*\(/g,
  /\bjest\.mock\s*\(/g,
  /\bjest\.spyOn\s*\(/g,
];

const KEEP_DIR_NAMES = new Set(["test", "tests", "e2e", "integration"]);

function shouldSkipDir(name, fullPath) {
  if (SKIP_DIRS.has(name)) return true;
  for (const fragment of SKIP_PATH_FRAGMENTS) {
    if (fullPath.includes(fragment)) return true;
  }
  return false;
}

function isTestFile(name) {
  return TEST_EXTS.some((ext) => name.endsWith(ext));
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, full)) continue;
      yield* walk(full);
    } else if (entry.isFile() && isTestFile(entry.name)) {
      yield full;
    }
  }
}

function detectInfix(basename) {
  let stem = basename;
  for (const ext of TEST_EXTS) {
    if (stem.endsWith(ext)) {
      stem = stem.slice(0, -ext.length);
      break;
    }
  }
  if (stem.endsWith(".real.e2e")) return "real.e2e";
  if (stem.endsWith(".live.e2e")) return "live.e2e";
  if (stem.endsWith(".real")) return "real";
  if (stem.endsWith(".live")) return "live";
  if (stem.endsWith(".integration")) return "integration";
  if (stem.endsWith(".scenario")) return "scenario";
  if (stem.endsWith(".e2e")) return "e2e";
  return "";
}

function inDirNamed(relPath, names) {
  // True only when one of the named segments appears anywhere in the relative path.
  // This deliberately matches `__tests__` parents only when followed by a known infix —
  // bare `__tests__/foo.test.ts` does NOT match because `__tests__` is not in the set.
  const segments = relPath.split(path.sep);
  return segments.some((seg) => names.has(seg));
}

function countMatches(content, patterns) {
  let total = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (matches) total += matches.length;
  }
  return total;
}

function anyMatch(content, patterns) {
  return patterns.some((p) => {
    p.lastIndex = 0;
    return p.test(content);
  });
}

function detectOutsidePackageInfraImport(content) {
  // Heuristic: imports of any non-relative module whose specifier path ends in
  // /runtime, /adapter, or /service (or those bare names). Catches things like
  // "@elizaos/core/runtime" or "../adapter" only when the spec is non-relative.
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRegex.exec(content))) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    if (
      /(?:^|\/)(?:runtime|adapter|service)$/i.test(spec) ||
      /\/(?:runtime|adapter|service)\//i.test(spec)
    ) {
      return true;
    }
  }
  return false;
}

function classify(relPath, content, head, infix) {
  const runtimeImports = anyMatch(head, RUNTIME_IMPORT_PATTERNS);
  const mockoonImports = anyMatch(head, MOCKOON_PATTERNS);
  const playwright = anyMatch(head, PLAYWRIGHT_PATTERNS);
  const realApiSignals = anyMatch(head, REAL_API_PATTERNS);
  const browserInfra = anyMatch(content, BROWSER_INFRA_PATTERNS);
  const spawn = anyMatch(content, SPAWN_PATTERNS);

  const keepInfix = ["real", "live", "real.e2e", "live.e2e", "e2e", "integration", "scenario"]
    .includes(infix);
  const inTestDir = inDirNamed(relPath, KEEP_DIR_NAMES);

  let keepReason = "";
  if (runtimeImports) keepReason = "runtime_imports";
  else if (mockoonImports) keepReason = "mockoon_imports";
  else if (playwright) keepReason = "playwright";
  else if (browserInfra) keepReason = "http_server_setup";
  else if (spawn) keepReason = "spawns_processes";
  else if (keepInfix) keepReason = `infix:${infix}`;
  else if (inTestDir) keepReason = "in_test_directory";

  if (keepReason) {
    return {
      cls: "KEEP",
      reason: keepReason,
      runtime_imports: runtimeImports,
      mockoon_imports: mockoonImports,
      real_api_signals: realApiSignals,
      playwright,
    };
  }

  const viCount = countMatches(content, VI_MOCK_PATTERNS);
  const jestCount = countMatches(content, JEST_MOCK_PATTERNS);
  const mockDensity = viCount + jestCount;
  const hasOutsidePackageInfraImport = detectOutsidePackageInfraImport(content);

  if (mockDensity > 0 && !hasOutsidePackageInfraImport) {
    return {
      cls: "DELETE",
      reason: `mocks_no_io_density=${mockDensity}`,
      runtime_imports: false,
      mockoon_imports: false,
      real_api_signals: realApiSignals,
      playwright: false,
    };
  }

  return {
    cls: "CONVERT",
    reason: hasOutsidePackageInfraImport
      ? "imports_runtime_like_module"
      : mockDensity > 0
        ? "mocks_with_outside_infra"
        : "pure_unit_no_signals",
    runtime_imports: false,
    mockoon_imports: false,
    real_api_signals: realApiSignals,
    playwright: false,
  };
}

function suggestRename(basename, cls, infix, runtimeOrMockoon) {
  if (cls === "DELETE") return "";
  let ext = "";
  for (const e of TEST_EXTS) {
    if (basename.endsWith(e)) {
      ext = e;
      break;
    }
  }
  if (!ext) return "";
  const stem = basename.slice(0, -ext.length);

  if (infix === "live.e2e") {
    return stem.replace(/\.live\.e2e$/, "") + ".e2e" + ext;
  }
  if (infix === "live") {
    if (runtimeOrMockoon) {
      return stem.replace(/\.live$/, "") + ".e2e" + ext;
    }
    return stem.replace(/\.live$/, "") + ".real.e2e" + ext;
  }
  if (infix === "real") {
    return stem.replace(/\.real$/, "") + ".real.e2e" + ext;
  }
  return "";
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function classifyFile(absPath) {
  const relPath = path.relative(REPO_ROOT, absPath);
  const stat = fs.statSync(absPath);
  if (stat.size > SIZE_WARN_LIMIT) {
    process.stderr.write(
      `[triage-tests] WARN: skipping large file ${relPath} (${stat.size}b)\n`
    );
    return null;
  }

  const fd = fs.openSync(absPath, "r");
  let head;
  try {
    const len = Math.min(stat.size, HEAD_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    head = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }

  const fullContent = stat.size <= HEAD_BYTES ? head : fs.readFileSync(absPath, "utf8");

  const basename = path.basename(absPath);
  const infix = detectInfix(basename);

  const decision = classify(relPath, fullContent, head, infix);

  const mockDensity =
    countMatches(fullContent, VI_MOCK_PATTERNS) +
    countMatches(fullContent, JEST_MOCK_PATTERNS);

  const suggestedName = suggestRename(
    basename,
    decision.cls,
    infix,
    decision.runtime_imports || decision.mockoon_imports
  );

  return {
    path: relPath,
    class: decision.cls,
    mock_density: mockDensity,
    filename_infix: infix,
    runtime_imports: decision.runtime_imports,
    mockoon_imports: decision.mockoon_imports,
    real_api_signals: decision.real_api_signals,
    playwright: decision.playwright,
    suggested_name: suggestedName,
    reason: decision.reason,
  };
}

function writeCsv(rows, outPath) {
  const header = [
    "path",
    "class",
    "mock_density",
    "filename_infix",
    "runtime_imports",
    "mockoon_imports",
    "real_api_signals",
    "playwright",
    "suggested_name",
    "reason",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.path),
        csvEscape(row.class),
        csvEscape(row.mock_density),
        csvEscape(row.filename_infix),
        csvEscape(row.runtime_imports),
        csvEscape(row.mockoon_imports),
        csvEscape(row.real_api_signals),
        csvEscape(row.playwright),
        csvEscape(row.suggested_name),
        csvEscape(row.reason),
      ].join(",")
    );
  }
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
}

function listPlugins() {
  const pluginsDir = path.join(REPO_ROOT, "plugins");
  if (!fs.existsSync(pluginsDir)) return [];
  return fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !shouldSkipDir(e.name, path.join(pluginsDir, e.name)))
    .map((e) => path.join("plugins", e.name));
}

function pluginRowsByPlugin(rows) {
  const map = new Map();
  for (const row of rows) {
    const segs = row.path.split(path.sep);
    if (segs[0] !== "plugins" || segs.length < 2) continue;
    if (segs.includes("dist") || segs.includes("node_modules")) continue;
    const key = segs.slice(0, 2).join(path.sep);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function area(p) {
  if (p.startsWith("plugins" + path.sep)) return "plugins";
  if (p.startsWith("packages" + path.sep)) return "packages";
  if (p.startsWith("cloud" + path.sep)) return "cloud";
  return "other";
}

function writeSummary(rows, outPath) {
  const total = rows.length;
  const counts = { KEEP: 0, DELETE: 0, CONVERT: 0 };
  const byArea = {};
  for (const row of rows) {
    counts[row.class] = (counts[row.class] || 0) + 1;
    const a = area(row.path);
    byArea[a] = byArea[a] || { KEEP: 0, DELETE: 0, CONVERT: 0, total: 0 };
    byArea[a][row.class] = (byArea[a][row.class] || 0) + 1;
    byArea[a].total += 1;
  }

  const topDelete = rows
    .filter((r) => r.class === "DELETE")
    .sort((a, b) => b.mock_density - a.mock_density)
    .slice(0, 20);

  const allPlugins = listPlugins();
  const pluginRows = pluginRowsByPlugin(rows);
  const pluginsZero = allPlugins.filter((p) => !pluginRows.has(p)).sort();

  const pluginsAllDelete = [];
  for (const [plugin, prows] of pluginRows.entries()) {
    if (prows.length === 0) continue;
    if (prows.every((r) => r.class === "DELETE")) {
      pluginsAllDelete.push({ plugin, count: prows.length });
    }
  }
  pluginsAllDelete.sort((a, b) => b.count - a.count || a.plugin.localeCompare(b.plugin));

  const nontrivialRenames = rows
    .filter((r) => r.suggested_name && path.basename(r.path) !== r.suggested_name)
    .sort((a, b) => a.path.localeCompare(b.path));

  const lines = [];
  lines.push("# Test Triage Summary");
  lines.push("");
  lines.push(
    `Generated by \`scripts/triage-tests.mjs\`. ${total} test files scanned.`
  );
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(`- Total: **${total}**`);
  lines.push(
    `- KEEP: **${counts.KEEP}** (${((counts.KEEP / total) * 100).toFixed(1)}%)`
  );
  lines.push(
    `- DELETE: **${counts.DELETE}** (${((counts.DELETE / total) * 100).toFixed(1)}%)`
  );
  lines.push(
    `- CONVERT: **${counts.CONVERT}** (${((counts.CONVERT / total) * 100).toFixed(1)}%)`
  );
  lines.push("");
  lines.push("### Per-area");
  lines.push("");
  lines.push("| Area | Total | KEEP | DELETE | CONVERT |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const a of Object.keys(byArea).sort()) {
    const v = byArea[a];
    lines.push(`| ${a} | ${v.total} | ${v.KEEP} | ${v.DELETE} | ${v.CONVERT} |`);
  }
  lines.push("");
  lines.push("## Top 20 DELETE candidates by mock density");
  lines.push("");
  if (topDelete.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| Mock density | Path |");
    lines.push("| ---: | --- |");
    for (const r of topDelete) {
      lines.push(`| ${r.mock_density} | \`${r.path}\` |`);
    }
  }
  lines.push("");
  lines.push("## Plugins with zero test files");
  lines.push("");
  lines.push(`Total: **${pluginsZero.length}**`);
  lines.push("");
  if (pluginsZero.length === 0) {
    lines.push("_All plugins have at least one test._");
  } else {
    for (const p of pluginsZero) {
      lines.push(`- \`${p}\``);
    }
  }
  lines.push("");
  lines.push("## Plugins where every test is a DELETE candidate");
  lines.push("");
  if (pluginsAllDelete.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| Plugin | DELETE count |");
    lines.push("| --- | ---: |");
    for (const { plugin, count } of pluginsAllDelete) {
      lines.push(`| \`${plugin}\` | ${count} |`);
    }
  }
  lines.push("");
  lines.push("## Files with non-trivial suggested renames");
  lines.push("");
  lines.push(`Total: **${nontrivialRenames.length}**`);
  lines.push("");
  if (nontrivialRenames.length > 0) {
    lines.push("| Current path | Suggested filename |");
    lines.push("| --- | --- |");
    for (const r of nontrivialRenames) {
      lines.push(`| \`${r.path}\` | \`${r.suggested_name}\` |`);
    }
  }
  lines.push("");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
}

function main() {
  const start = Date.now();
  const rows = [];
  for (const file of walk(REPO_ROOT)) {
    const row = classifyFile(file);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));

  const csvPath = path.join(REPO_ROOT, "coverage-matrix.csv");
  writeCsv(rows, csvPath);

  const summaryPath = path.join(REPO_ROOT, "scripts", "triage-tests.summary.md");
  writeSummary(rows, summaryPath);

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  process.stdout.write(
    `[triage-tests] scanned ${rows.length} test files in ${elapsed}s\n` +
      `[triage-tests] coverage-matrix.csv -> ${csvPath}\n` +
      `[triage-tests] summary -> ${summaryPath}\n`
  );
}

main();
