#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-mcp (TypeScript package).
 *
 * Outputs:
 * - ESM (Node): dist/node/index.js
 * - CJS (Node): dist/cjs/index.cjs
 * - Types: dist/index.d.ts + dist/node/index.d.ts + dist/cjs/index.d.ts
 *
 * Runs on the shared `buildPlugin` driver. The CJS bundle is renamed
 * `index.js` -> `index.cjs` with a plain rename; its sibling `index.js.map` is
 * intentionally left unrenamed so the emitted `//# sourceMappingURL=index.js.map`
 * reference stays valid.
 */
import { buildPlugin } from "../plugin-build";

const reexport = (from: string) => `export * from "${from}";\nexport { default } from "${from}";\n`;

await buildPlugin({
  name: "@elizaos/plugin-mcp",
  // Wipe dist first so leftover .d.ts files from prior runs don't get picked up
  // by tsc as inputs (TS5055).
  clean: true,
  externals: "auto",
  externalsOptions: {
    // Transitive workspace + native deps that must stay external.
    extra: ["@elizaos/shared", "@elizaos/agent", "@node-llama-cpp", "node-llama-cpp"],
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
      // Rename Bun's CJS output to .cjs to be loadable under "type": "module".
      renames: [["index.js", "index.cjs"]],
    },
  ],
  // Type-emit uses a dedicated project because plugin-mcp transitively imports
  // @elizaos/agent, whose type errors are outside this package's control.
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "index.d.ts", content: reexport("./node/index") },
    { path: "cjs/index.d.ts", content: reexport("../node/index") },
  ],
});
