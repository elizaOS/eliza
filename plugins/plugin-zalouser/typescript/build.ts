import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: ["@elizaos/core"],
});

// Generate declarations
const { $ } = await import("bun");
await $`tsc --emitDeclarationOnly`;
