import { build } from "bun";

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core", "viem", "drizzle-orm"],
});

const proc = Bun.spawn(
  ["bunx", "tsc", "-p", "tsconfig.dts.json"],
  {
    cwd: import.meta.dir,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const procExit = await proc.exited;
if (procExit !== 0) {
  process.exit(procExit);
}

console.log("Build complete!");
