#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const turboBin = path.join(repoRoot, "node_modules/.bin/turbo");

const child = spawn(turboBin, process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

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
