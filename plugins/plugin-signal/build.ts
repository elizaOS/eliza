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

const proc = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
  cwd: import.meta.dir,
  stdout: "inherit",
  stderr: "inherit",
});

const code = await proc.exited;
if (code !== 0) {
  process.exit(code);
}

console.log("Build complete!");
