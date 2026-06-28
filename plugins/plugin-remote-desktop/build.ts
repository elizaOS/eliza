import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "bun";

const distDir = join(import.meta.dir, "dist");
const RM_RECURSIVE_SCRIPT = fileURLToPath(
  new URL("../../packages/scripts/rm-path-recursive.mjs", import.meta.url),
);

function rmRecursive(target: string) {
  const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `rm-path-recursive failed for ${target} with status ${result.status}`,
    );
  }
}

try {
  rmRecursive(distDir);
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
