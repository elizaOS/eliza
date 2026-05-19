import { rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "bun";

const distDir = join(import.meta.dir, "dist");

try {
  rmSync(distDir, { recursive: true, force: true });
} catch {
  // ignore
}

console.log("Building @elizaos/plugin-todos...");

await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core"],
});

console.log("Build complete.");

const proc = Bun.spawn(
  ["bunx", "tsc", "-p", "tsconfig.build.json", "--emitDeclarationOnly"],
  {
    cwd: import.meta.dir,
    stdio: ["inherit", "inherit", "inherit"],
  },
);

await proc.exited;

console.log("Types generated.");
