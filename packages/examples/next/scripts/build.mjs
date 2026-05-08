import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const nextCliPath = require.resolve("next/dist/bin/next");
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const finalDistDir = ".next";
const tempDistDir = ".next-build";
const nextEnvPath = "next-env.d.ts";
const tsconfigPath = "tsconfig.json";
const tsbuildInfoPath = "tsconfig.tsbuildinfo";
const originalNextEnv = await readFile(nextEnvPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") {
    return null;
  }

  throw error;
});
const originalTsconfig = await readFile(tsconfigPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") {
    return null;
  }

  throw error;
});

await rm(tempDistDir, {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100,
});
await rm(tsbuildInfoPath, {
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});

let exitCode = 1;

try {
  exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [nextCliPath, "build"], {
      cwd: pkgRoot,
      env: { ...process.env, NEXT_DIST_DIR: tempDistDir },
      stdio: "inherit",
    });

    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode === 0) {
    await rm(finalDistDir, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
    await rename(tempDistDir, finalDistDir);
  } else {
    await rm(tempDistDir, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
} finally {
  if (originalNextEnv !== null) {
    await writeFile(nextEnvPath, originalNextEnv);
  }
  if (originalTsconfig !== null) {
    await writeFile(tsconfigPath, originalTsconfig);
  }
  await rm(tsbuildInfoPath, {
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

process.exit(exitCode);
