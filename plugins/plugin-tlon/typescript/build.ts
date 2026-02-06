import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: ["@elizaos/core"],
});

// Generate type declarations using tsc
const tsc = Bun.spawn(["tsc", "--emitDeclarationOnly"], {
  cwd: import.meta.dir,
  stdout: "inherit",
  stderr: "inherit",
});

await tsc.exited;

console.log("Build complete!");
