#!/usr/bin/env node
/**
 * Per-package knip runner.
 *
 * Plain `knip` on this monorepo OOMs (it loads the full ~4k-file workspace
 * graph at once). This runs knip ISOLATED per workspace — single-project mode,
 * `@elizaos/*` treated as external — so each run is bounded in memory and time.
 *
 * Entry points are derived from each package.json's `exports`/`main`/`bin`
 * (dist target → src source) so public subpath APIs used by OTHER packages are
 * NOT mis-flagged as unused. The reliable per-package signals are:
 *   - unused files (within the package, after exports are excluded)
 *   - unused dependencies / devDependencies
 *
 * NOTE: cross-package usage of a non-exported symbol can't be seen in isolated
 * mode, so treat "unused files" as CANDIDATES to verify with a repo-wide grep,
 * not as ground truth. Unused deps are higher-confidence (still verify).
 *
 * Usage:
 *   node scripts/knip-per-package.mjs [--filter <substr>] [--out <dir>] [--heap <mb>] [--timeout <s>]
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";

const REPO = process.cwd();
const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const FILTER = getArg("--filter", "");
const OUT = getArg("--out", join(REPO, ".knip-per-package"));
const HEAP = getArg("--heap", "4096");
const TIMEOUT = Number(getArg("--timeout", "120"));

mkdirSync(OUT, { recursive: true });

/** Map a dist target like ./dist/brand/index.js → candidate src entries. */
function distToSrc(target) {
  if (typeof target !== "string") return [];
  let t = target.replace(/^\.\//, "");
  t = t.replace(/^dist\//, "src/").replace(/^build\//, "src/");
  const base = t.replace(/\.(js|cjs|mjs|d\.ts)$/, "");
  return [`${base}.ts`, `${base}.tsx`];
}

/** Collect all export target strings from an exports map (recursive). */
function collectTargets(exp, acc) {
  if (typeof exp === "string") acc.push(exp);
  else if (Array.isArray(exp)) exp.forEach((e) => collectTargets(e, acc));
  else if (exp && typeof exp === "object")
    Object.values(exp).forEach((e) => collectTargets(e, acc));
}

function deriveEntries(pkgJson, pkgDir) {
  const entries = new Set();
  const add = (cands) =>
    cands.forEach((c) => {
      if (existsSync(join(pkgDir, c))) entries.add(c);
    });
  // exports map
  if (pkgJson.exports) {
    const targets = [];
    collectTargets(pkgJson.exports, targets);
    targets.forEach((t) => add(distToSrc(t)));
  }
  // main / module / types
  for (const f of [pkgJson.main, pkgJson.module, pkgJson.types]) {
    if (f) add(distToSrc(f));
  }
  // bin
  if (pkgJson.bin) {
    const bins =
      typeof pkgJson.bin === "string"
        ? [pkgJson.bin]
        : Object.values(pkgJson.bin);
    bins.forEach((b) => add(distToSrc(b)));
  }
  // common fallbacks + build scripts (entry-ish)
  add([
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    "src/cli.ts",
    "src/entry.ts",
    "build.ts",
    "build.mjs",
    "build.config.ts",
  ]);
  return [...entries];
}

// Discover workspace package dirs (packages/*, plugins/*), skip examples/benchmarks.
function discover() {
  const dirs = [];
  for (const root of ["packages", "plugins"]) {
    const rootPath = join(REPO, root);
    if (!existsSync(rootPath)) continue;
    for (const name of readdirSync(rootPath)) {
      const d = join(root, name);
      if (!existsSync(join(REPO, d, "package.json"))) continue;
      if (/examples|benchmarks/.test(d)) continue;
      if (!existsSync(join(REPO, d, "src"))) continue;
      dirs.push(d);
    }
  }
  return dirs.sort();
}

const pkgs = discover().filter((d) => !FILTER || d.includes(FILTER));
console.error(`[knip-per-package] ${pkgs.length} workspaces -> ${OUT}`);

const summary = [];
for (const pkgDir of pkgs) {
  const abs = join(REPO, pkgDir);
  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const entries = deriveEntries(pkgJson, abs);
  const cfg = {
    entry: entries.length ? entries : ["src/**/*.ts"],
    project: ["src/**/*.{ts,tsx}"],
    ignore: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**", "**/*.d.ts"],
    ignoreDependencies: ["@elizaos/.*"],
    ignoreBinaries: [".*"],
    includeEntryExports: false,
  };
  const cfgPath = join(abs, ".knip-isolated.tmp.json");
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const slug = pkgDir.replace(/\//g, "_");
  const outFile = join(OUT, `${slug}.txt`);
  let rc = 0;
  let body = "";
  try {
    body = execFileSync(
      "bunx",
      [
        "knip",
        "--config",
        ".knip-isolated.tmp.json",
        "--no-config-hints",
        "--include",
        "files,dependencies",
        "--no-progress",
      ],
      {
        cwd: abs,
        timeout: TIMEOUT * 1000,
        env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP}` },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    rc = e.status ?? (e.signal ? 137 : 1);
    body = (e.stdout || "") + (e.stderr || "");
  } finally {
    try {
      rmSync(cfgPath);
    } catch {}
  }
  const files = (body.match(/^Unused files \((\d+)\)/m) || [])[1] || "0";
  const deps = (body.match(/^Unused dependencies \((\d+)\)/m) || [])[1] || "0";
  const ddeps =
    (body.match(/^Unused devDependencies \((\d+)\)/m) || [])[1] || "0";
  const timedOut = rc === 143 || rc === 137;
  writeFileSync(outFile, `# ${pkgDir}  rc=${rc}\n${body}`);
  summary.push({ pkgDir, files: +files, deps: +deps, ddeps: +ddeps, rc, timedOut });
  console.error(
    `  ${pkgDir.padEnd(46)} files=${files} deps=${deps} devDeps=${ddeps} ${timedOut ? "TIMEOUT/OOM" : ""}`,
  );
}

summary.sort((a, b) => b.files + b.deps + b.ddeps - (a.files + a.deps + a.ddeps));
writeFileSync(join(OUT, "_summary.json"), JSON.stringify(summary, null, 2));
const totFiles = summary.reduce((s, x) => s + x.files, 0);
const totDeps = summary.reduce((s, x) => s + x.deps + x.ddeps, 0);
const failed = summary.filter((x) => x.timedOut).map((x) => x.pkgDir);
console.error(
  `\n[knip-per-package] done. candidate unused files=${totFiles}, unused deps=${totDeps}. ` +
    `timeouts/OOM: ${failed.length}${failed.length ? " (" + failed.join(", ") + ")" : ""}`,
);
console.error(`[knip-per-package] per-package output + _summary.json in ${OUT}`);
