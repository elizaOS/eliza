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

// Emit declarations without semantic type-checking, matching this package's
// own `typecheck: "skipped for release"` script and the @elizaos/skills build
// (`tsc --noCheck`). The release d.ts emit must not hard-fail on cross-package
// type resolution (e.g. when @elizaos/core is consumed at a different version).
const proc = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json", "--noCheck"], {
  cwd: import.meta.dir,
  stdout: "inherit",
  stderr: "inherit",
});

const code = await proc.exited;
if (code !== 0) {
  process.exit(code);
}

console.log("Build complete!");
