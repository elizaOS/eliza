import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: ["@elizaos/core"],
});

// Generate type declarations
const proc = Bun.spawn(
  ["tsc", "--emitDeclarationOnly", "-p", "tsconfig.build.json"],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);

await proc.exited;

console.log("Build completed successfully");
