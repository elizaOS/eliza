import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core"],
});

// Generate declaration files
const proc = Bun.spawn(
  ["bunx", "tsc", "--emitDeclarationOnly", "--declaration", "--outDir", "dist"],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
await proc.exited;

console.log("Build complete");
