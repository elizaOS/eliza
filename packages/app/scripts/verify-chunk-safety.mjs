#!/usr/bin/env node
// Build-time gate against the recurring crypto-chunk crash
// ("Class constructor u cannot be invoked without 'new'" at Buffer.allocUnsafe).
//
// Root cause (see resolveManualChunk in vite.config.ts): when the bn.js/crypto
// graph is not pinned to its own chunk, Rollup folds it into an EAGERLY-
// initialized chunk (the date-fns `en_US` i18n locale chunk, or the entry).
// bn.js runs `Buffer.allocUnsafe` at module-init, which throws before the
// bundled Buffer wrapper is ready and kills the whole React tree on every
// route. The #9150 instance of this was a placement bug: the `manualChunks`
// pin sat under `build.rolldownOptions.output` — a key Vite never reads — so it
// was silently ignored and NO vendor chunks emitted. The fix moves the pin to
// `build.rollupOptions.output` (the key Vite + classic Rollup read) and folds
// the crypto/wallet/solana graph into one lazy `vendor-crypto` chunk.
//
// Root cause (see resolveManualChunk's vendor-crypto group in vite.config.ts):
// Rolldown can non-deterministically fold the bn.js / crypto graph into an
// EAGERLY-initialized chunk (an i18n locale chunk or the entry). bn.js runs
// `Buffer.allocUnsafe` at module-init, which throws before the bundled Buffer
// wrapper is ready and kills the whole React tree on every route. The fix keeps
// that graph in a dedicated LAZY `vendor-crypto` chunk — but the fix has been
// silently dropped multiple times (history squashes / a package cutover) and a
// bad build shipped to prod each time.
//
// This gate fails the build whenever the bn.js marker (`toArrayLike`) lands in
// any chunk that is NOT one of the intended lazy `vendor-*` vendor chunks, so a
// regressed bundle can never deploy. Run after `vite build`, before deploy.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const distRoot = path.join(process.cwd(), "dist");
const distAssets = path.join(process.cwd(), "dist", "assets");
const indexHtmlPath = path.join(distRoot, "index.html");

// bn.js's `toArrayLike` is the method that calls `Buffer.allocUnsafe` at
// module-init; its presence marks the crypto/big-number graph.
const CRYPTO_MARKER = "toArrayLike";

// The crypto graph is allowed to live ONLY in these lazily-loaded vendor
// chunks (loaded on demand by wallet/crypto routes), never in the eager entry
// or locale chunks. Matches the `vendor-crypto` / `vendor-wallet` /
// `vendor-solana` groups in vite.config.ts's resolveManualChunk.
const ALLOWED = /^vendor-(crypto|solana|wallet)-/;

let files;
try {
  files = readdirSync(distAssets).filter((f) => f.endsWith(".js"));
} catch (err) {
  console.error(
    `[verify-chunk-safety] cannot read ${distAssets}: ${err.message}`,
  );
  process.exit(2);
}

function collectReferencedJsFiles() {
  let indexHtml;
  try {
    indexHtml = readFileSync(indexHtmlPath, "utf8");
  } catch {
    return new Set(files);
  }

  const referenced = new Set();
  const pending = [];
  const addAssetRef = (rawRef, fromFile = null) => {
    if (!rawRef?.endsWith(".js")) return;
    let normalized = rawRef;
    if (normalized.startsWith("/")) normalized = normalized.slice(1);
    if (normalized.startsWith("./")) {
      normalized = fromFile
        ? path.posix.normalize(
            path.posix.join(path.posix.dirname(fromFile), normalized),
          )
        : normalized.slice(2);
    }
    if (!normalized.startsWith("assets/")) return;
    const file = normalized.slice("assets/".length);
    if (!file.endsWith(".js") || referenced.has(file)) return;
    if (!existsSync(path.join(distAssets, file))) return;
    referenced.add(file);
    pending.push(file);
  };

  const htmlAssetRe = /(?:src|href)=["'](?:\/?)(assets\/[^"']+\.js)["']/g;
  let match = htmlAssetRe.exec(indexHtml);
  while (match !== null) {
    addAssetRef(match[1]);
    match = htmlAssetRe.exec(indexHtml);
  }

  while (pending.length > 0) {
    const file = pending.pop();
    const body = readFileSync(path.join(distAssets, file), "utf8");
    const jsAssetRe =
      /(?:from\s*["']|import\s*\(\s*["'])(\.\/[^"']+\.js)["']|["'](assets\/[^"']+\.js)["']/g;
    let jsMatch = jsAssetRe.exec(body);
    while (jsMatch !== null) {
      addAssetRef(jsMatch[1] || jsMatch[2], `assets/${file}`);
      jsMatch = jsAssetRe.exec(body);
    }
  }

  return referenced.size > 0 ? referenced : new Set(files);
}

const referencedFiles = collectReferencedJsFiles();
const offenders = [];
let cryptoChunkSeen = false;
for (const file of files) {
  if (!referencedFiles.has(file)) continue;
  const hasMarker = readFileSync(path.join(distAssets, file), "utf8").includes(
    CRYPTO_MARKER,
  );
  if (!hasMarker) continue;
  if (ALLOWED.test(file)) {
    cryptoChunkSeen = true;
  } else {
    offenders.push(file);
  }
}

if (offenders.length > 0) {
  console.error(
    "[verify-chunk-safety] FAIL: the bn.js/crypto graph leaked into eager chunk(s):",
  );
  for (const f of offenders) console.error(`  - ${f}`);
  console.error(
    "\nThis is the crypto-chunk crash (Buffer.allocUnsafe at module-init).\n" +
      "The `vendor-crypto` branch in vite.config.ts's resolveManualChunk must keep\n" +
      "the bn.js graph in a lazy vendor chunk, and that manualChunks fn must stay\n" +
      "wired under `build.rollupOptions.output` (the key Vite reads). Do NOT deploy\n" +
      "this bundle — it crashes the whole React tree on every route.",
  );
  process.exit(1);
}

if (!cryptoChunkSeen) {
  console.warn(
    "[verify-chunk-safety] note: no crypto graph found in any chunk (unexpected " +
      "but not a crash risk) — passing.",
  );
}

console.log(
  `[verify-chunk-safety] OK: bn.js/crypto graph is confined to lazy vendor chunks (${referencedFiles.size} current chunks scanned).`,
);

// ── Boot-path eagerness guard ──
// Confinement alone is not enough: `vendor-crypto` can be perfectly confined
// yet still be a STATIC import of the entry chunk, which makes the browser
// fetch + parse the whole multi-MB wallet graph before first paint on every
// boot (web and the Capacitor iOS/Android WebView alike). The known cause is a
// manual-chunk pin on a first-party module: Rollup folds a pinned module's
// entire dependency subtree into the manual chunk, so pinning an app component
// drags the shared @elizaos/core + UI graph — which the entry needs — into
// `vendor-crypto`, and the entry then imports the chunk statically (#13187
// residual). This guard walks the entry's static-import closure and fails if
// any heavyweight lazy-by-design vendor chunk is reachable without a dynamic
// `import()` boundary.
const MUST_STAY_LAZY =
  /^vendor-(crypto|solana|wallet|three|vrm|draco|phonemizer)-/;

function collectEntryStaticClosure() {
  let indexHtml;
  try {
    indexHtml = readFileSync(indexHtmlPath, "utf8");
  } catch {
    return null;
  }
  const entryMatch = indexHtml.match(
    /<script[^>]*type="module"[^>]*src="(?:\/?|\.\/)?(assets\/[^"]+\.js)"/,
  );
  if (!entryMatch) return null;
  const entryFile = entryMatch[1].slice("assets/".length);

  const seen = new Set([entryFile]);
  const pending = [entryFile];
  // Static edges only: `from"./x.js"`, bare `import"./x.js"`, and
  // `export…from"./x.js"`. Dynamic `import("./x.js")` has a paren after
  // `import`, so it never matches — dynamic boundaries end the walk.
  const staticImportRe = /(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g;
  while (pending.length > 0) {
    const file = pending.pop();
    const filePath = path.join(distAssets, file);
    if (!existsSync(filePath)) continue;
    const body = readFileSync(filePath, "utf8");
    let m = staticImportRe.exec(body);
    while (m !== null) {
      const dep = path.posix.normalize(m[1]).replace(/^\.\//, "");
      if (dep.endsWith(".js") && !seen.has(dep)) {
        seen.add(dep);
        pending.push(dep);
      }
      m = staticImportRe.exec(body);
    }
    staticImportRe.lastIndex = 0;
  }
  return { entryFile, closure: seen };
}

const entryClosure = collectEntryStaticClosure();
if (entryClosure) {
  const eagerHeavy = [...entryClosure.closure].filter((f) =>
    MUST_STAY_LAZY.test(f),
  );
  if (eagerHeavy.length > 0) {
    console.error(
      `[verify-chunk-safety] FAIL: lazy-by-design vendor chunk(s) are in the entry's STATIC import closure (fetched+parsed on every boot before first paint):`,
    );
    for (const f of eagerHeavy) console.error(`  - ${f}`);
    console.error(
      "\nMost likely a manual-chunk pin on a first-party source module: Rollup\n" +
        "folds a pinned module's whole dependency subtree into the manual chunk,\n" +
        "which captures the shared core/UI graph the entry needs and anchors the\n" +
        "chunk into the boot path. Pin only node_modules/facade ids (see\n" +
        "vite/wallet-chunk-matcher.ts) and keep first-party consumers behind\n" +
        "dynamic import() boundaries. Do NOT deploy this bundle.",
    );
    process.exit(1);
  }
  console.log(
    `[verify-chunk-safety] OK: entry static closure (${entryClosure.closure.size} chunks from ${entryClosure.entryFile}) contains no lazy-by-design vendor chunk.`,
  );
} else {
  console.warn(
    "[verify-chunk-safety] note: no module-script entry found in dist/index.html — skipping the eagerness guard.",
  );
}

// ── Web SPA base regression guard ──
// build:web sets ELIZA_WEB_ABSOLUTE_BASE=1 → Vite base "/". A relative base
// ("./assets/…") boots fine at depth-1 routes (/, /login) but 404s its bundle
// at depth-2+ routes (/auth/cli-login, /app-auth/authorize, /payment/:id):
// "./assets/x.js" resolves to /<route-dir>/assets/x.js, which the SPA fallback
// serves as text/html, so the module/stylesheet is refused and the page blanks.
// This shipped to prod once (the cli-login device-login handoff). Fail the build
// if the absolute-base web bundle still emitted relative asset refs. Native /
// relative builds don't set the flag, so this guard is skipped for them — their
// relative base is correct (Electrobun views:// / Capacitor file://).
if (process.env.ELIZA_WEB_ABSOLUTE_BASE === "1") {
  const indexHtmlPath = path.join(process.cwd(), "dist", "index.html");
  let indexHtml;
  try {
    indexHtml = readFileSync(indexHtmlPath, "utf8");
  } catch (err) {
    console.error(
      `[verify-chunk-safety] cannot read ${indexHtmlPath} for the web-base check: ${err.message}`,
    );
    process.exit(2);
  }
  const relativeAssetRefs = indexHtml.match(/(?:src|href)="\.\/assets\//g);
  if (relativeAssetRefs) {
    console.error(
      `[verify-chunk-safety] FAIL: ELIZA_WEB_ABSOLUTE_BASE=1 but dist/index.html still has ${relativeAssetRefs.length} relative "./assets/" ref(s).`,
    );
    console.error(
      "\nThe web SPA base regressed to relative. Depth-2+ routes (/auth/cli-login,\n" +
        "/app-auth/authorize, /payment/:id) would resolve assets to /<route>/assets/…,\n" +
        "which the SPA fallback serves as text/html → the bundle never boots → blank\n" +
        "page. Keep `base` absolute for the web build (vite.config.ts:\n" +
        '`process.env.ELIZA_WEB_ABSOLUTE_BASE === "1" ? "/" : "./"`). Do NOT deploy.',
    );
    process.exit(1);
  }
  console.log(
    "[verify-chunk-safety] OK: web SPA uses an absolute base (no relative ./assets/ refs in index.html).",
  );
}
