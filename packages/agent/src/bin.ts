#!/usr/bin/env node
import { runAutonomousCli } from "./cli/index.js";
// Static import so `Bun.build` pulls the AOSP llama loader into the mobile
// bundle. The adapter self-gates on `MILADY_LOCAL_LLAMA=1` and no-ops on
// every other platform/runtime, so the import is safe everywhere; we only
// need it bundled so `ensure-local-inference-handler.ts`'s dynamic import of
// `@elizaos/agent/runtime/aosp-llama-adapter` resolves on-device. Registration
// itself happens through that handler, not from this side-effect import.
//
// We capture the named export into `globalThis` to defeat Bun.build's
// tree-shaking — a bare side-effect import would let the bundler drop
// `registerAospLlamaLoader` because nothing else in this entry references it,
// which is exactly what we observed empirically (only the source-map comment
// survived, the symbol did not). Dropping it would silently break the
// dynamic import path on AOSP. Keep this guard pinned.
import { registerAospLlamaLoader as __miladyAospLlamaLoader } from "./runtime/aosp-llama-adapter.js";

(
  globalThis as { __miladyAospLlamaLoader?: typeof __miladyAospLlamaLoader }
).__miladyAospLlamaLoader = __miladyAospLlamaLoader;

runAutonomousCli().catch((error) => {
  console.error(
    "[eliza-autonomous] Failed to start:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
