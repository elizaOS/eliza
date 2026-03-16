import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core", "@slack/bolt", "@slack/web-api", "zod"],
});

// Generate type declarations
const proc = Bun.spawn(
  ["bunx", "tsc", "--emitDeclarationOnly", "--declaration", "--declarationMap"],
  {
    cwd: import.meta.dir,
    stdout: "inherit",
    stderr: "inherit",
  },
);

await proc.exited;

console.log("Build complete!");
