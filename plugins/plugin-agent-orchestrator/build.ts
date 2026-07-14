#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-agent-orchestrator (Node + Node CJS).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts); this
 * lists only what differs.
 *
 * No browser build: this plugin includes Node-only services (ACP subprocess
 * sessions, workspace lifecycle, child_process spawn). Browser callers should
 * only depend on the type definitions; the package's `exports` field points the
 * browser condition at the same node bundle for resolution purposes but the
 * runtime is Node/bun.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    { path: "index.d.ts", content: reexport("./node/index") },
    { path: "node/index.d.ts", content: reexport("./index.node") },
    { path: "cjs/index.d.ts", content: reexport("./index.node") },
  ],
});

// The packaged Linux runtime installs this plugin far from any checkout, so
// no emitted bundle may embed the build machine's absolute source path
// (bundlers bake import.meta.url/__dirname as literals).
const distRoot = fileURLToPath(new URL("./dist", import.meta.url));
const forbiddenRoot = fileURLToPath(new URL("../../", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
const leaked = files(distRoot).filter((file) =>
  readFileSync(file).includes(Buffer.from(forbiddenRoot)),
);
if (leaked.length > 0) {
  throw new Error(
    `[plugin-agent-orchestrator] built runtime contains the source checkout path: ${leaked.join(", ")}`,
  );
}
