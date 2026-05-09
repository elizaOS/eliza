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
  ["bunx", "tsc", "--emitDeclarationOnly", "--project", "tsconfig.build.json"],
  {
    cwd: import.meta.dir,
    stdout: "inherit",
    stderr: "inherit",
  }
);

const declarationExitCode = await proc.exited;
if (declarationExitCode !== 0) {
  process.exit(declarationExitCode);
}

console.log("Build complete!");
