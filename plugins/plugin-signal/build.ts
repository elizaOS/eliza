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

const dts = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.dts.json"], {
  cwd: import.meta.dir,
  stdout: "inherit",
  stderr: "inherit",
});

const dtsExit = await dts.exited;
if (dtsExit !== 0) {
  process.exit(dtsExit);
}

console.log("Build complete!");
