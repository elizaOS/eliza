#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-groq (Node + Browser + CJS).
 * Orchestration lives in the shared driver; this lists only what differs.
 *
 * Note: the root alias re-exports `./node/index.node` (not `./node/index`) to
 * avoid a `index.d.ts → node/index.node.d.ts → index.d.ts` cycle, and the
 * tsc-emitted `node/index.d.ts` is deliberately left in place (no node shim).
 */
import { buildPlugin } from "../plugin-build";

const reexport = (from: string) => `export * from "${from}";\nexport { default } from "${from}";\n`;

await buildPlugin({
  name: "@elizaos/plugin-groq",
  clean: true,
  targets: [
    { label: "Node", entry: "index.node.ts", outSubdir: "node", target: "node", format: "esm" },
    {
      label: "Browser",
      entry: "index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
    },
    {
      label: "Node (CJS)",
      entry: "index.node.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      renames: [["index.node.js", "index.node.cjs"]],
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "index.d.ts", content: reexport("./node/index.node") },
    { path: "browser/index.d.ts", content: reexport("./index.browser") },
    { path: "cjs/index.d.ts", content: reexport("./index.node") },
  ],
});
