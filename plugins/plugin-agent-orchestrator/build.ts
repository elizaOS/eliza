#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-agent-orchestrator (Node + Node CJS).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts); this
 * lists only what differs.
 *
 * This entry builds Node services. The separate build:ui command emits the
 * browser-safe /ui subpaths and view bundle without subprocess dependencies.
 */
import { buildPlugin } from "../plugin-build";

const reexport = (from: string) =>
  `export * from "${from}";\nexport { default } from "${from}";\n`;

await buildPlugin({
  name: "@elizaos/plugin-agent-orchestrator",
  externals: "auto",
  targets: [
    {
      label: "Node",
      entry: "index.node.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "index.d.ts", content: reexport("./node/index") },
    { path: "node/index.d.ts", content: reexport("./index.node") },
    { path: "cjs/index.d.ts", content: reexport("./index.node") },
  ],
});

// The ESM-then-CJS sequence fails in one Bun 1.4.2 process while a fresh
// CJS build succeeds. Keep both formats and isolate the second build.
const cjsBuild = Bun.spawn(
  [process.execPath, `${import.meta.dir}/scripts/build-cjs.ts`],
  {
    cwd: import.meta.dir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
const cjsExit = await cjsBuild.exited;
if (cjsExit !== 0) {
  throw new Error(`CJS build failed with exit code ${cjsExit}`);
}
