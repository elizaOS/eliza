import { build } from "bun";
import { rmSync, cpSync } from "fs";
import { join } from "path";

const distDir = join(import.meta.dir, "dist");

// Clean dist directory
try {
  rmSync(distDir, { recursive: true, force: true });
} catch {
  // ignore
}

console.log("Building TypeScript plugin...");

// Build ESM
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

// Generate types
const proc = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json", "--emitDeclarationOnly"], {
  cwd: import.meta.dir,
  stdio: ["inherit", "inherit", "inherit"],
});

await proc.exited;

console.log("Types generated!");


