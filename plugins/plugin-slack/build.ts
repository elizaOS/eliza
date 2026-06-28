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

const proc = Bun.spawn(
  ["bunx", "tsc", "-p", "tsconfig.build.json", "--noCheck"],
  {
    cwd: import.meta.dir,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  console.error("TypeScript declaration generation failed");
  process.exit(exitCode);
}

console.log("Build complete!");
