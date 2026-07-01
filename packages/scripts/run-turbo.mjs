#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const turboShimCandidates =
  process.platform === "win32"
    ? [
        path.join(repoRoot, "node_modules/.bin/turbo.exe"),
        path.join(repoRoot, "node_modules/.bin/turbo"),
      ]
    : [path.join(repoRoot, "node_modules/.bin/turbo")];
const turboShim = turboShimCandidates.find((candidate) =>
  fs.existsSync(candidate),
);
const turboPackageBin = path.join(repoRoot, "node_modules/turbo/bin/turbo");
const turboArgs = process.argv.slice(2);

if (!turboArgs.some((arg) => arg === "--ui" || arg.startsWith("--ui="))) {
  turboArgs.unshift("--ui=stream");
}

const runIndex = turboArgs.indexOf("run");
if (
  runIndex !== -1 &&
  !turboArgs.some(
    (arg) => arg === "--log-order" || arg.startsWith("--log-order="),
  )
) {
  turboArgs.splice(runIndex + 1, 0, "--log-order=stream");
}

const turboCommand = turboShim ?? process.execPath;
const turboCommandArgs = turboShim
  ? turboArgs
  : [turboPackageBin, ...turboArgs];

if (!turboShim && !fs.existsSync(turboPackageBin)) {
  console.error(
    `Unable to find turbo. Expected one of ${turboShimCandidates.join(", ")} or ${turboPackageBin}.`,
  );
  process.exit(1);
}

let child;
try {
  child = spawn(turboCommand, turboCommandArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
} catch (error) {
  console.error(`Failed to start turbo: ${error.message}`);
  process.exit(1);
}

const warningStart = "An issue occurred while attempting to parse";

function filterKnownBunLockWarning(stream, output) {
  let pending = "";
  let skipping = 0;

  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (line.includes(warningStart) && line.includes("bun.lock")) {
        skipping = 3;
        continue;
      }
      if (skipping > 0) {
        skipping -= 1;
        continue;
      }
      output.write(`${line}\n`);
    }
  });

  stream.on("end", () => {
    if (pending && skipping === 0 && !pending.includes(warningStart)) {
      output.write(pending);
    }
  });
}

filterKnownBunLockWarning(child.stdout, process.stdout);
filterKnownBunLockWarning(child.stderr, process.stderr);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start turbo: ${error.message}`);
  process.exit(1);
});
