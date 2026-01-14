import { rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "bun";

const distDir = join(import.meta.dir, "dist");

try {
  rmSync(distDir, { recursive: true, force: true });
} catch {
  // ignore
}

await build({
  entrypoints: ["./index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core", "zod"],
});

const proc = Bun.spawn(
  ["bunx", "tsc", "-p", "tsconfig.build.json", "--emitDeclarationOnly"],
  {
    cwd: import.meta.dir,
    stdio: ["inherit", "inherit", "inherit"],
  },
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  throw new Error(`TypeScript declaration build failed (exit ${exitCode})`);
}
