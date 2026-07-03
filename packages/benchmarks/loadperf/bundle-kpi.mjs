/**
 * Bundle-size KPI.
 *
 * Measures the production frontend bundle in `packages/app/dist`:
 *  - raw + brotli size of every JS/CSS asset
 *  - the initial entry chunk (what index.html loads eagerly)
 *  - duplicate chunks (the same compiled content emitted more than once)
 *  - heavy-library spread (e.g. three.js shipped as three.module + three.webgpu + vendor-three)
 *  - per-chunk offenders over the warn budget
 *
 * Runs entirely off the on-disk build — no server needed. Build first with:
 *   bun run --cwd packages/app build      (or the repo `bun run build`)
 *
 * Usage: node packages/benchmarks/loadperf/bundle-kpi.mjs [--json]
 */

import { createHash } from "node:crypto";

import {
  APP_DIST,
  basename,
  existsSync,
  extname,
  join,
  kb,
  loadBudgets,
  mb,
  measureFile,
  pct,
  readFileSync,
  recordResult,
  relative,
  walk,
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

const HEAVY_LIB_KEYWORDS = [
  "three",
  "lucide-react",
  "phonemizer",
  "draco",
  "vrm",
  "babylon",
  "monaco",
];

function detectInitialEntries() {
  // index.html references the eager entry module(s). Multiple html files = multiple entry points.
  const entries = new Set();
  for (const html of walk(APP_DIST).filter((f) => f.endsWith(".html"))) {
    const src = readFileSync(html, "utf8");
    for (const m of src.matchAll(
      /<script[^>]+type="module"[^>]+src="([^"]+)"/g,
    )) {
      entries.add(basename(m[1]));
    }
    for (const m of src.matchAll(
      /<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g,
    )) {
      entries.add(basename(m[1]));
    }
  }
  return entries;
}

/**
 * Compute the EAGER graph — every chunk the browser parses before first paint.
 * Starting from the entry/modulepreload chunks, follow only STATIC import edges
 * (bare `"…chunk.js"` string references) and skip dynamic `import("…")` edges,
 * which are lazy. This is what actually gates first load; the rest of dist is
 * lazy (route chunks, worker/wasm blobs like phonemizer, three on companion
 * mount) and must not be conflated with the critical path.
 */
function computeEagerGraph(assets, entryNames) {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const staticEdges = new Map(); // name -> Set(staticallyReferenced names)
  const CHUNK_REF = /['"`]([\w./-]+\.(?:js|css))['"`]/g;
  const DYN_IMPORT = /import\(\s*['"`]([^'"`]+\.js)['"`]\s*\)/g;
  for (const a of assets) {
    if (a.ext !== ".js") continue;
    const src = readFileSync(join(APP_DIST, a.path), "utf8");
    const dyn = new Set();
    for (const m of src.matchAll(DYN_IMPORT)) dyn.add(basename(m[1]));
    const statics = new Set();
    for (const m of src.matchAll(CHUNK_REF)) {
      const ref = basename(m[1]);
      if (ref !== a.name && byName.has(ref) && !dyn.has(ref)) statics.add(ref);
    }
    staticEdges.set(a.name, statics);
  }
  // BFS over static edges from the entry set.
  const eager = new Set(entryNames);
  const queue = [...entryNames];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of staticEdges.get(cur) ?? []) {
      if (!eager.has(next)) {
        eager.add(next);
        queue.push(next);
      }
    }
  }
  return { eager };
}

function main() {
  if (!existsSync(APP_DIST)) {
    console.error(
      `[bundle-kpi] no build at ${APP_DIST} — run \`bun run --cwd packages/app build\` first.`,
    );
    process.exit(2);
  }

  // Measure each asset. A concurrent build can delete/replace files between the
  // directory walk and the read (ENOENT); partial numbers would be misleading,
  // so treat an unstable dist as "skipped" (exit 2) rather than crashing or
  // silently under-counting. Only ENOENT is tolerated here — any other read
  // error is a real fault and must propagate.
  const vanished = [];
  const assets = walk(APP_DIST)
    .filter((f) => [".js", ".css"].includes(extname(f)))
    .map((f) => {
      let m;
      try {
        m = measureFile(f);
      } catch (err) {
        if (err?.code === "ENOENT") {
          vanished.push(relative(APP_DIST, f));
          return null;
        }
        throw err;
      }
      return {
        path: relative(APP_DIST, f),
        name: basename(f),
        logical: logicalName(f),
        ext: extname(f),
        ...m,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.brotli - a.brotli);

  if (vanished.length > 0) {
    console.error(
      `[bundle-kpi] dist unstable: ${vanished.length} file(s) vanished mid-scan ` +
        `(concurrent build?). Numbers would be partial — skipping. ` +
        `Re-run against a finished, stable build. e.g.: ${vanished[0]}`,
    );
    process.exit(2);
  }

  const totalRaw = assets.reduce((s, a) => s + a.raw, 0);
  const totalBrotli = assets.reduce((s, a) => s + a.brotli, 0);

  // Duplicate chunks: the same compiled content emitted more than once (e.g.
  // one copy per HTML entry point). Copies must be matched by CONTENT — with
  // rollup content hashes stripped, so two copies that differ only in the
  // hashed filenames of the sibling chunks they reference still match — never
  // by chunk basename: dozens of unrelated modules legitimately share generic
  // basenames (`index` for every npm package entry, `register-terminal-view`
  // once per view, …), so a basename group says nothing about shipped bytes.
  const ROLLUP_HASH_REF = /-[A-Za-z0-9_-]{8}\.(js|css)\b/g;
  const byContent = new Map();
  for (const a of assets) {
    const src = readFileSync(join(APP_DIST, a.path), "utf8");
    const key = createHash("sha256")
      .update(src.replace(ROLLUP_HASH_REF, ".$1"))
      .digest("hex");
    const arr = byContent.get(key) ?? [];
    arr.push(a);
    byContent.set(key, arr);
  }
  const duplicates = [...byContent.values()]
    .filter((arr) => arr.length > 1)
    .map((arr) => ({
      logical: arr[0].logical,
      files: arr.map((a) => a.name),
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
  if (entryNames.size === 0 || entryAssets.length === 0) {
    const error =
      entryNames.size === 0
        ? "no module scripts or modulepreload entries found in app dist HTML"
        : `HTML referenced ${entryNames.size} initial asset(s), but none were present in dist`;
    const result = {
      skipped: true,
      error,
      summary: {
        assetCount: assets.length,
        totalRaw,
        totalBrotli,
      },
    };
    const { file } = recordResult("bundle", result, NOW);
    console.error(`[bundle-kpi] ${error}; recorded -> ${file}`);
    process.exit(2);
  }
  const initialEntryBrotli = entryAssets.reduce((s, a) => s + a.brotli, 0);
  const largest = assets[0];

  // Eager graph: everything parsed before first paint (entry + its static deps).
  // This is the honest "JS loaded up front" number; the rest is lazy.
  const { eager } = computeEagerGraph(assets, entryNames);
  const eagerAssets = assets.filter((a) => eager.has(a.name));
  const eagerBrotli = eagerAssets.reduce((s, a) => s + a.brotli, 0);
  const eagerRaw = eagerAssets.reduce((s, a) => s + a.raw, 0);
  const lazyBrotli = totalBrotli - eagerBrotli;

  const budgets = loadBudgets().bundle;
  const maxDup = duplicates[0]?.wastedBrotli ?? 0;
  const checks = [
    {
      name: "initialEntryBrotli",
      value: initialEntryBrotli,
      budget: budgets.initialEntryBrotliBytes,
    },
    {
      name: "totalAssetsBrotli",
      value: totalBrotli,
      budget: budgets.totalAssetsBrotliBytes,
    },
    {
      name: "largestChunkBrotli",
      value: largest?.brotli ?? 0,
      budget: budgets.largestChunkBrotliBytes,
    },
    {
      name: "maxDuplicateLibBytes",
      value: maxDup,
      budget: budgets.maxDuplicateLibBytes,
    },
  ];
  // Eager-graph budget is opt-in (only checked when a budget is declared) so this
  // stays backward-compatible with existing budgets.json files.
  if (budgets.eagerGraphBrotliBytes != null)
    checks.push({
      name: "eagerGraphBrotli",
      value: eagerBrotli,
      budget: budgets.eagerGraphBrotliBytes,
    });
  for (const c of checks) c.pass = c.value <= c.budget;

  const offenders = assets.filter(
    (a) => a.brotli > budgets.perChunkWarnBrotliBytes,
  );

  const result = {
    summary: {
      assetCount: assets.length,
      totalRaw,
      totalBrotli,
      initialEntryBrotli,
      initialEntryFiles: entryAssets.map((a) => a.name),
      eagerChunkCount: eagerAssets.length,
      eagerRaw,
      eagerBrotli,
      lazyBrotli,
      largestChunk: largest
        ? { name: largest.name, raw: largest.raw, brotli: largest.brotli }
        : null,
      duplicateWastedBrotli: duplicates.reduce((s, d) => s + d.wastedBrotli, 0),
    },
    topChunks: assets.slice(0, 25).map((a) => ({
      name: a.name,
      raw: a.raw,
      brotli: a.brotli,
      eager: eager.has(a.name),
    })),
    duplicates: duplicates.slice(0, 20),
    libSpread,
    offendersOverWarn: offenders.map((a) => ({
      name: a.name,
      brotli: a.brotli,
    })),
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
  console.log(
    `EAGER (first paint): ${kb(s.eagerBrotli)} brotli / ${mb(s.eagerRaw)} raw across ${s.eagerChunkCount} chunks`,
  );
  console.log(`lazy (on demand):  ${kb(s.lazyBrotli)} brotli`);
  console.log(
    `initial entry:     ${kb(s.initialEntryBrotli)} brotli  (${s.initialEntryFiles.join(", ") || "?"})`,
  );
  if (s.largestChunk)
    console.log(
      `largest chunk:     ${s.largestChunk.name}  ${kb(s.largestChunk.brotli)} brotli / ${mb(s.largestChunk.raw)} raw`,
    );
  console.log(
    `dup waste:         ${mb(s.duplicateWastedBrotli)} brotli (identical chunk content emitted more than once)`,
  );

  console.log("\n-- top 12 chunks by brotli  (E=eager / lazy) --");
  for (const c of r.topChunks.slice(0, 12)) {
    console.log(
      `  ${c.eager ? "E" : " "} ${kb(c.brotli).padStart(11)}  ${pct(c.brotli, s.totalBrotli).padStart(6)}  ${c.name}`,
    );
  }

  console.log("\n-- duplicate chunks (wasted = extra copies) --");
  if (r.duplicates.length === 0) console.log("  none");
  for (const d of r.duplicates.slice(0, 10)) {
    console.log(
      `  ${d.copies}x  ${kb(d.wastedBrotli).padStart(11)} wasted  ${d.logical} (each ${kb(d.eachBrotli)}): ${d.files.join(", ")}`,
    );
  }

  console.log("\n-- heavy library spread --");
  for (const l of r.libSpread) {
    console.log(
      `  ${kb(l.totalBrotli).padStart(11)}  ${l.lib}: ${l.chunkCount} chunk(s) [${l.chunkNames.join(", ")}]`,
    );
  }

  console.log("\n-- budget checks --");
  for (const c of r.checks) {
    console.log(
      `  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${kb(c.value)} / budget ${kb(c.budget)}`,
    );
  }
  console.log(`\nresult: ${r.pass ? "PASS" : "FAIL"}   recorded -> ${file}\n`);
}

main();
