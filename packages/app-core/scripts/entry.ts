#!/usr/bin/env node
/**
 * Thin shim that defers to the real CLI entry at ../src/entry.ts.
 *
 * The Eliza root `start:eliza` script invokes this path via
 * `node scripts/run-eliza-app-core-script.mjs entry.ts start`, which expects
 * the file to live under `<app-core>/scripts/`. The actual implementation
 * lives at `src/entry.ts` (built into `dist/entry.js`); keeping this shim
 * avoids duplicating the bootstrapping logic in two places.
 */
import "../src/entry";
