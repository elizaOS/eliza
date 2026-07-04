#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-benchmarks (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 *
 * The single `index.ts` entry is bundled for Node with an external sourcemap.
 * Declarations are emitted via tsconfig.build.json (tolerated on failure), and
 * the root `index.d.ts` alias is written as a hand-rolled re-export.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-benchmarks",
  clean: true,
  targets: [
    {
      label: "Node",
      entry: "index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      sourcemap: "external",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsTolerant: true,
  dtsShims: [
    {
      path: "index.d.ts",
      content: 'export * from "./index";\nexport { default } from "./index";\n',
    },
  ],
});
