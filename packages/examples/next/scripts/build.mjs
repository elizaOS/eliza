import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

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
    const child = spawn("next", ["build"], {
      env: { ...process.env, NEXT_DIST_DIR: tempDistDir },
      shell: process.platform === "win32",
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
