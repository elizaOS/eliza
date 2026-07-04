#!/usr/bin/env bun
import { buildPlugin } from "../plugin-build";

/**
 * Build script for @elizaos/plugin-gitpathologist.
 *
 * Outputs:
 * - ESM (Node): dist/node/index.js
 * - CJS (Node): dist/cjs/index.cjs
 * - Types: dist/index.d.ts + dist/node/index.d.ts + dist/cjs/index.d.ts
 *
 * Runs on the shared `buildPlugin` driver. The CJS bundle's `index.js` is
 * renamed to `index.cjs`; its sibling `index.js.map` is intentionally left
 * unrenamed so the emitted `//# sourceMappingURL=index.js.map` reference stays
 * valid.
 */
const reexport = (from: string) => `export * from "${from}";\nexport { default } from "${from}";\n`;

await buildPlugin({
  name: "@elizaos/plugin-gitpathologist",
  clean: true,
  externals: "auto",
  externalsOptions: { extra: ["@elizaos/shared", "@elizaos/agent"] },
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
    { path: "index.d.ts", content: reexport("./node/index") },
    { path: "cjs/index.d.ts", content: reexport("../node/index") },
  ],
});
