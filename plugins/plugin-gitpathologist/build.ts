#!/usr/bin/env bun

/**
 * Build entrypoint for the git-pathology plugin.
 * It uses the shared plugin build driver to emit Node ESM/CJS bundles and declarations while preserving CJS sourcemap references.
 */

import { buildPlugin } from "../plugin-build";

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
