/** Builds desktop with the same pinned Rollup Vite as build:web, then gates its output. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function buildDesktopRenderer({ appDir, env, label, runBun }) {
  const require = createRequire(path.join(appDir, "package.json"));
  const viteCli = path.join(
    path.dirname(require.resolve("@elizaos/vitest-vite/package.json")),
    "bin",
    "vite.js",
  );
  if (!existsSync(viteCli)) {
    throw new Error(`Pinned renderer Vite CLI is missing: ${viteCli}`);
  }
  // Keep Bun's runtime, but never let bunx select a different Vite major whose
  // chunking options differ from the app's Rollup manualChunks contract.
  runBun([viteCli, "build"], { cwd: appDir, env, label });
  for (const guard of ["verify-chunk-safety.ts", "verify-viewport-meta.ts"]) {
    runBun([path.join(appDir, "scripts", guard)], {
      cwd: appDir,
      env,
      label: `Validating renderer: ${guard}`,
    });
  }
}
