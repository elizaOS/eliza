import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core", "zod"],
});

// Generate type declarations
const proc = Bun.spawn(
  [
    "bunx",
    "tsc",
    "-p",
    "tsconfig.json",
    "--emitDeclarationOnly",
    "--declaration",
    "--declarationMap",
    "--noEmit",
    "false",
    "--outDir",
    "./dist",
    "--rootDir",
    "./src",
  ],
  {
    cwd: import.meta.dir,
    stdout: "inherit",
    stderr: "inherit",
  },
);

await proc.exited;

console.log("Build complete!");
