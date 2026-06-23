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

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const distRoot = path.join(process.cwd(), "dist");
const distAssets = path.join(process.cwd(), "dist", "assets");

// bn.js's `toArrayLike` is the method that calls `Buffer.allocUnsafe` at
// module-init; its presence marks the crypto/big-number graph.
const CRYPTO_MARKER = "toArrayLike";

// The crypto graph is allowed to live ONLY in these lazily-loaded vendor
// chunks (loaded on demand by wallet/crypto routes), never in the eager entry
// or locale chunks. Matches the `vendor-crypto` / `vendor-wallet` /
// `vendor-solana` groups in vite.config.ts's resolveManualChunk.
const ALLOWED = /^vendor-(crypto|solana|wallet)-/;
const HAZARDOUS_VENDOR_CHUNK = /^vendor-(crypto|solana|wallet)-.*\.js$/;

function getAttr(tag, attr) {
  const match = tag.match(new RegExp(`\\b${attr}\\s*=\\s*(['"])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function assetNameFromHref(href) {
  const clean = href.split(/[?#]/, 1)[0]?.replace(/^\.\//, "") ?? "";
  if (!clean.startsWith("assets/")) return null;
  return path.basename(clean);
}

function assetPathFromHref(href) {
  const clean = href.split(/[?#]/, 1)[0]?.replace(/^\.\//, "") ?? "";
  if (!clean.startsWith("assets/")) return null;
  return path.join(distRoot, clean);
}

let files;
try {
  files = readdirSync(distAssets).filter((f) => f.endsWith(".js"));
} catch (err) {
  console.error(
    `[verify-chunk-safety] cannot read ${distAssets}: ${err.message}`,
  );
  process.exit(2);
}

const offenders = [];
const eagerOffenders = [];
let cryptoChunkSeen = false;
for (const file of files) {
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

const indexHtmlPath = path.join(distRoot, "index.html");
let indexHtml;
try {
  indexHtml = readFileSync(indexHtmlPath, "utf8");
} catch (err) {
  console.error(
    `[verify-chunk-safety] cannot read ${indexHtmlPath}: ${err.message}`,
  );
  process.exit(2);
}

const entryHrefs = [];
for (const linkMatch of indexHtml.matchAll(/<link\b[^>]*>/gi)) {
  const tag = linkMatch[0];
  const rel = getAttr(tag, "rel");
  const href = getAttr(tag, "href");
  if (!rel || !href) continue;
  if (!rel.split(/\s+/).includes("modulepreload")) continue;
  const assetName = assetNameFromHref(href);
  if (assetName && HAZARDOUS_VENDOR_CHUNK.test(assetName)) {
    eagerOffenders.push(`index.html modulepreload -> ${href}`);
  }
}

for (const scriptMatch of indexHtml.matchAll(/<script\b[^>]*>/gi)) {
  const tag = scriptMatch[0];
  const src = getAttr(tag, "src");
  if (!src) continue;
  const assetName = assetNameFromHref(src);
  if (assetName && HAZARDOUS_VENDOR_CHUNK.test(assetName)) {
    eagerOffenders.push(`index.html entry script -> ${src}`);
  }
  entryHrefs.push(src);
}

for (const href of entryHrefs) {
  const entryPath = assetPathFromHref(href);
  if (!entryPath) continue;
  let entryCode;
  try {
    entryCode = readFileSync(entryPath, "utf8");
  } catch (err) {
    console.error(
      `[verify-chunk-safety] cannot read entry script ${entryPath}: ${err.message}`,
    );
    process.exit(2);
  }
  const eagerImportRe =
    /(?:\bimport\s*["'](\.\/vendor-(?:crypto|solana|wallet)-[^"']+\.js)["']|\bfrom\s*["'](\.\/vendor-(?:crypto|solana|wallet)-[^"']+\.js)["'])/g;
  for (const match of entryCode.matchAll(eagerImportRe)) {
    eagerOffenders.push(`${path.basename(entryPath)} static import -> ${match[1] ?? match[2]}`);
  }
}

if (offenders.length > 0 || eagerOffenders.length > 0) {
  console.error(
    "[verify-chunk-safety] FAIL: the bn.js/crypto graph is not lazy-safe:",
  );
  if (offenders.length > 0) {
    console.error("  marker leaked into eager chunk(s):");
    for (const f of offenders) console.error(`    - ${f}`);
  }
  if (eagerOffenders.length > 0) {
    console.error("  hazardous vendor chunk is eagerly loaded:");
    for (const f of eagerOffenders) console.error(`    - ${f}`);
  }
  console.error(
    "\nThis is the crypto-chunk crash (Buffer.allocUnsafe at module-init).\n" +
      "The `vendor-crypto` branch in vite.config.ts's resolveManualChunk must keep\n" +
      "the bn.js graph in a lazy vendor chunk, and renderer entry imports must not\n" +
      "pull that chunk into index.html modulepreload or static entry imports. Do NOT\n" +
      "deploy this bundle — it crashes the whole React tree on every route.",
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
  `[verify-chunk-safety] OK: bn.js/crypto graph is confined to lazy vendor chunks (${files.length} chunks scanned).`,
);
