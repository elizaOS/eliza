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

const distAssets = path.join(process.cwd(), "dist", "assets");

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

const offenders = [];
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
  `[verify-chunk-safety] OK: bn.js/crypto graph is confined to lazy vendor chunks (${files.length} chunks scanned).`,
);
