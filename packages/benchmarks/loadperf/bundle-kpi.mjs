/**
 * Bundle-size KPI.
 *
 * Measures the production frontend bundle in `packages/app/dist`:
 *  - raw + brotli size of every JS/CSS asset
 *  - the initial entry chunk (what index.html loads eagerly)
 *  - duplicate chunks (same logical name emitted once per entry point)
 *  - heavy-library spread (e.g. three.js shipped as three.module + three.webgpu + vendor-three)
 *  - per-chunk offenders over the warn budget
 *
 * Runs entirely off the on-disk build — no server needed. Build first with:
 *   bun run --cwd packages/app build      (or the repo `bun run build`)
 *
 * Usage: node packages/benchmarks/loadperf/bundle-kpi.mjs [--json]
 */

import {
  APP_DIST,
  walk,
  measureFile,
  loadBudgets,
  recordResult,
  kb,
  mb,
  pct,
  relative,
  basename,
  extname,
  readFileSync,
  existsSync,
  join,
} from "./lib.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");

/** Strip the rollup content hash: `index-CJm3VPr6.js` -> `index`, `three.module-Cb9.js` -> `three.module`. */
function logicalName(file) {
  const ext = extname(file);
  let name = basename(file, ext);
  // trailing -<hash> where hash is 8+ base64url-ish chars
  name = name.replace(/-[A-Za-z0-9_]{8,}$/, "");
  return name;
}

const HEAVY_LIB_KEYWORDS = ["three", "lucide-react", "phonemizer", "draco", "vrm", "babylon", "monaco"];

function detectInitialEntries() {
  // index.html references the eager entry module(s). Multiple html files = multiple entry points.
  const entries = new Set();
  for (const html of walk(APP_DIST).filter((f) => f.endsWith(".html"))) {
    const src = readFileSync(html, "utf8");
    for (const m of src.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)) {
      entries.add(basename(m[1]));
    }
    for (const m of src.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) {
      entries.add(basename(m[1]));
    }
  }
  return entries;
}

function main() {
  if (!existsSync(APP_DIST)) {
    console.error(`[bundle-kpi] no build at ${APP_DIST} — run \`bun run --cwd packages/app build\` first.`);
    process.exit(2);
  }

  const assets = walk(APP_DIST)
    .filter((f) => [".js", ".css"].includes(extname(f)))
    .map((f) => {
      const m = measureFile(f);
      return {
        path: relative(APP_DIST, f),
        name: basename(f),
        logical: logicalName(f),
        ext: extname(f),
        ...m,
      };
    })
    .sort((a, b) => b.brotli - a.brotli);

  const totalRaw = assets.reduce((s, a) => s + a.raw, 0);
  const totalBrotli = assets.reduce((s, a) => s + a.brotli, 0);

  // Duplicate logical chunks (same name emitted N times — usually one per entry point).
  const byLogical = new Map();
  for (const a of assets) {
    const arr = byLogical.get(a.logical) ?? [];
    arr.push(a);
    byLogical.set(a.logical, arr);
  }
  const duplicates = [...byLogical.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([name, arr]) => ({
      logical: name,
      copies: arr.length,
      eachBrotli: arr[0].brotli,
      wastedBrotli: arr.slice(1).reduce((s, a) => s + a.brotli, 0),
    }))
    .sort((a, b) => b.wastedBrotli - a.wastedBrotli);

  // Heavy library spread (a single library shipped under several chunk names).
  const libSpread = HEAVY_LIB_KEYWORDS.map((kw) => {
    const matched = assets.filter((a) => a.logical.toLowerCase().includes(kw));
    const distinctChunks = new Set(matched.map((a) => a.logical));
    return {
      lib: kw,
      chunkNames: [...distinctChunks],
      chunkCount: distinctChunks.size,
      fileCount: matched.length,
      totalBrotli: matched.reduce((s, a) => s + a.brotli, 0),
    };
  })
    .filter((l) => l.fileCount > 0)
    .sort((a, b) => b.totalBrotli - a.totalBrotli);

  // Initial entry: the chunk(s) index.html eagerly loads.
  const entryNames = detectInitialEntries();
  const entryAssets = assets.filter((a) => entryNames.has(a.name));
  const initialEntryBrotli = entryAssets.reduce((s, a) => s + a.brotli, 0);
  const largest = assets[0];

  const budgets = loadBudgets().bundle;
  const maxDup = duplicates[0]?.wastedBrotli ?? 0;
  const checks = [
    { name: "initialEntryBrotli", value: initialEntryBrotli, budget: budgets.initialEntryBrotliBytes },
    { name: "totalAssetsBrotli", value: totalBrotli, budget: budgets.totalAssetsBrotliBytes },
    { name: "largestChunkBrotli", value: largest?.brotli ?? 0, budget: budgets.largestChunkBrotliBytes },
    { name: "maxDuplicateLibBytes", value: maxDup, budget: budgets.maxDuplicateLibBytes },
  ].map((c) => ({ ...c, pass: c.value <= c.budget }));

  const offenders = assets.filter((a) => a.brotli > budgets.perChunkWarnBrotliBytes);

  const result = {
    summary: {
      assetCount: assets.length,
      totalRaw,
      totalBrotli,
      initialEntryBrotli,
      initialEntryFiles: entryAssets.map((a) => a.name),
      largestChunk: largest ? { name: largest.name, raw: largest.raw, brotli: largest.brotli } : null,
      duplicateWastedBrotli: duplicates.reduce((s, d) => s + d.wastedBrotli, 0),
    },
    topChunks: assets.slice(0, 25).map((a) => ({ name: a.name, raw: a.raw, brotli: a.brotli })),
    duplicates: duplicates.slice(0, 20),
    libSpread,
    offendersOverWarn: offenders.map((a) => ({ name: a.name, brotli: a.brotli })),
    checks,
    pass: checks.every((c) => c.pass),
  };

  const { file } = recordResult("bundle", result, NOW);

  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    print(result, file);
  }
  process.exit(result.pass ? 0 : 1);
}

function print(r, file) {
  const s = r.summary;
  console.log("\n=== Bundle KPI (packages/app/dist) ===");
  console.log(`assets:            ${s.assetCount} JS/CSS files`);
  console.log(`total raw:         ${mb(s.totalRaw)}`);
  console.log(`total brotli:      ${mb(s.totalBrotli)}`);
  console.log(`initial entry:     ${kb(s.initialEntryBrotli)} brotli  (${s.initialEntryFiles.join(", ") || "?"})`);
  if (s.largestChunk)
    console.log(`largest chunk:     ${s.largestChunk.name}  ${kb(s.largestChunk.brotli)} brotli / ${mb(s.largestChunk.raw)} raw`);
  console.log(`dup waste:         ${mb(s.duplicateWastedBrotli)} brotli (same chunk emitted per entry point)`);

  console.log("\n-- top 12 chunks by brotli --");
  for (const c of r.topChunks.slice(0, 12)) {
    console.log(`  ${kb(c.brotli).padStart(11)}  ${pct(c.brotli, s.totalBrotli).padStart(6)}  ${c.name}`);
  }

  console.log("\n-- duplicate chunks (wasted = extra copies) --");
  for (const d of r.duplicates.slice(0, 10)) {
    console.log(`  ${d.copies}x  ${kb(d.wastedBrotli).padStart(11)} wasted  ${d.logical} (each ${kb(d.eachBrotli)})`);
  }

  console.log("\n-- heavy library spread --");
  for (const l of r.libSpread) {
    console.log(`  ${kb(l.totalBrotli).padStart(11)}  ${l.lib}: ${l.chunkCount} chunk(s) [${l.chunkNames.join(", ")}]`);
  }

  console.log("\n-- budget checks --");
  for (const c of r.checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${kb(c.value)} / budget ${kb(c.budget)}`);
  }
  console.log(`\nresult: ${r.pass ? "PASS" : "FAIL"}   recorded -> ${file}\n`);
}

main();
