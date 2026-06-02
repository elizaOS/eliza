import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nextCliPath = require.resolve("next/dist/bin/next");
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const finalDistDir = path.join(packageRoot, ".next");
const tempDistDirName = `.next-build-${process.pid}`;
const tempDistDir = path.join(packageRoot, tempDistDirName);

await rm(tempDistDir, {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100,
});

async function runNextBuild(args) {
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [nextCliPath, "build", ...args], {
      cwd: packageRoot,
      env: {
        ...process.env,
        NEXT_DIST_DIR: tempDistDirName,
      },
      stdio: "inherit",
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });

  return exitCode;
}

// Next 15 can hang indefinitely in the default monolithic build mode for this
// workspace example after the server compile emits. The same work completes
// deterministically when split into Next's documented compile/generate phases.
let exitCode = await runNextBuild(["--experimental-build-mode", "compile"]);

if (exitCode === 0) {
  exitCode = await runNextBuild(["--experimental-build-mode", "generate"]);
}

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

process.exit(exitCode);
