import { rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "bun";

const distDir = join(import.meta.dir, "dist");

try {
  rmSync(distDir, { recursive: true, force: true });
} catch {
  // ignore
}

console.log("Building TypeScript plugin...");

await build({
  entrypoints: ["./index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core", "cross-spawn", "zod"],
});

console.log("Build complete!");

const proc = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json", "--emitDeclarationOnly"], {
  cwd: import.meta.dir,
  stdio: ["inherit", "inherit", "inherit"],
});

await proc.exited;

console.log("Types generated!");
