import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "bun";

const distDir = join(import.meta.dir, "dist");
const rmRecursiveScript = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "scripts",
  "rm-path-recursive.mjs"
);

function rmRecursive(targetPath: string) {
  const result = spawnSync(process.execPath, [rmRecursiveScript, targetPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`failed to remove generated Shell build output ${targetPath}`);
  }
}

try {
  rmRecursive(distDir);
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
  external: ["@elizaos/core", "@elizaos/shared", "cross-spawn", "zod", "@lydell/node-pty"],
});

console.log("Build complete!");

const proc = Bun.spawn(
  ["bunx", "tsc", "-p", "tsconfig.build.json", "--emitDeclarationOnly", "--noCheck"],
  {
    cwd: import.meta.dir,
    stdio: ["inherit", "inherit", "inherit"],
  }
);

const exitCode = await proc.exited;

if (exitCode !== 0) {
  throw new Error(`Type declaration generation failed with exit code ${exitCode}`);
}

if (!existsSync(join(distDir, "index.d.ts"))) {
  throw new Error("Type declaration generation did not emit dist/index.d.ts");
}

console.log("Types generated!");
