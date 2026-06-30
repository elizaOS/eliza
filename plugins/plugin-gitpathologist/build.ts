#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-gitpathologist.
 *
 * Outputs:
 * - ESM (Node): dist/node/index.js
 * - CJS (Node): dist/cjs/index.cjs
 * - Types: dist/index.d.ts + dist/node/index.d.ts + dist/cjs/index.d.ts
 *
 * Migrated onto the shared `buildPlugin` driver (issue #10078). The CJS bundle
 * is renamed `index.js` -> `index.cjs` with a plain rename (its sibling
 * `index.js.map` is intentionally left unrenamed so the emitted
 * `//# sourceMappingURL=index.js.map` reference stays valid), byte-identical to
 * the prior hand-rolled build.
 */

import { buildPlugin } from "../plugin-build.ts";

await buildPlugin({
  name: "@elizaos/plugin-gitpathologist",
  clean: true,
  externals: "auto",
  externalsOptions: {
    extra: ["@elizaos/shared", "@elizaos/agent"],
  },
  targets: [
    {
      label: "Node (ESM)",
      entry: "src/index.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
      sourcemap: "external",
      minify: false,
    },
    {
      label: "Node (CJS)",
      entry: "src/index.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      sourcemap: "external",
      minify: false,
      renames: [["index.js", "index.cjs"]],
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    {
      path: "index.d.ts",
      content: `export * from "./node/index";
export { default } from "./node/index";
`,
    },
    {
      path: "cjs/index.d.ts",
      content: `export * from "../node/index";
export { default } from "../node/index";
`,
    },
  ],
});
