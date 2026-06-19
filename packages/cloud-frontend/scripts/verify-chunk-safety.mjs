#!/usr/bin/env node
// Build-time gate against the recurring Rolldown crypto-chunk crash
// ("Class constructor u cannot be invoked without 'new'" at Buffer.allocUnsafe).
//
// Root cause (see the vendor-crypto codeSplitting group in vite.config.ts):
// Rolldown can non-deterministically fold the bn.js / crypto graph into an
// EAGERLY-initialized chunk (the i18n locale chunk or the entry). bn.js runs
// `Buffer.allocUnsafe` at module-init, which throws before the bundled Buffer
// wrapper is ready and kills the whole React tree on every route. The fix keeps
// that graph in a dedicated LAZY `vendor-crypto` chunk — but the fix has been
// silently dropped twice (history squashes) and a bad build shipped to prod.
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
// or locale chunks.
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
    "\nThis is the Rolldown crypto-chunk crash (Buffer.allocUnsafe at module-init).\n" +
      "The `vendor-crypto` codeSplitting group in vite.config.ts must keep the\n" +
      "bn.js graph in a lazy vendor chunk. Do NOT deploy this bundle — it crashes\n" +
      "the whole React tree on every route. Re-check the codeSplitting groups.",
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
