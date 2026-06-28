#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-xai (Node + Browser + CJS).
 * Orchestration lives in the shared driver; this lists only what differs.
 *
 * Bundles `index.ts` (not the `index.node.ts` re-export shim) and renames the
 * output to `index.node.*`: bundling the shim triggers a Bun.build codegen bug
 * ("default2" is not declared). zod is externalized (transitive via core).
 */
import { buildPlugin } from "../plugin-build";

const reexport =
  "export * from '../index';\nexport { default } from '../index';\n";

await buildPlugin({
  name: "@elizaos/plugin-xai",
  externalsOptions: { extra: ["zod"] },
  targets: [
    {
      label: "Node (ESM)",
      entry: "index.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
      renames: [
        ["index.js", "index.node.js"],
        ["index.js.map", "index.node.js.map"],
      ],
    },
    {
      label: "Browser",
      entry: "index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      minify: true,
    },
    {
      label: "Node (CJS)",
      entry: "index.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      renames: [
        ["index.js", "index.node.cjs"],
        ["index.js.map", "index.node.cjs.map"],
      ],
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
    { path: "cjs/index.d.ts", content: reexport },
  ],
});
