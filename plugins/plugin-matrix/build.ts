import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: ["@elizaos/core", "matrix-js-sdk"],
});

// Also emit declarations with tsc
import { spawnSync } from "node:child_process";

spawnSync("bunx", ["tsc", "--emitDeclarationOnly"], { stdio: "inherit" });

console.log("Build complete");
