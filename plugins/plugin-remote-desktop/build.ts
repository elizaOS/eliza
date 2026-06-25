import { rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "bun";

const distDir = join(import.meta.dir, "dist");

try {
  rmSync(distDir, { recursive: true, force: true });
} catch {
  // ignore
}

console.log("Building @elizaos/plugin-remote-desktop...");

const result = await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core"],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("Bun bundle failed");
}

console.log("Build complete.");

const proc = Bun.spawn(
  [
    "bunx",
    "tsc",
    "-p",
    "tsconfig.build.json",
    "--emitDeclarationOnly",
    "--noCheck",
  ],
  {
    cwd: import.meta.dir,
    stdio: ["inherit", "inherit", "inherit"],
  },
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  throw new Error(
    `Type declaration generation failed with exit code ${exitCode}`,
  );
}

console.log("Types generated.");
