/**
 * Exercises key creation in real child processes, optionally holding the first
 * write after opening its real file so readers observe the publication boundary.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveTokenEncryptionKey } from "../token-encryption.js";

const [credentialsDir, participant, mode = "race"] = process.argv.slice(2);
if (!credentialsDir || !participant) {
  throw new Error("Expected credentials directory and participant id");
}

async function waitForStart(): Promise<void> {
  const gate = path.join(credentialsDir, "start");
  while (!fs.existsSync(gate)) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

if (mode === "no-ready") {
  await waitForStart();
} else if (mode === "hold-write") {
  const originalWrite = fs.writeFileSync;
  let holding = true;
  fs.writeFileSync = (file, data, options) => {
    if (!holding) return originalWrite(file, data, options);
    holding = false;
    // A path-based write opens the real target before writing, exactly as the
    // production call does; descriptor-based callers already own that open.
    const ownsDescriptor = typeof file !== "number";
    const descriptor = ownsDescriptor
      ? fs.openSync(
          file,
          options !== null && typeof options === "object"
            ? (options.flag ?? "w")
            : "w",
          options !== null && typeof options === "object"
            ? options.mode
            : undefined,
        )
      : file;
    try {
      originalWrite(path.join(credentialsDir, "paused"), "opened");
      const deadline = Date.now() + 15_000;
      const release = path.join(credentialsDir, "release");
      const signal = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting to release the key writer");
        }
        Atomics.wait(signal, 0, 0, 5);
      }
      originalWrite(descriptor, data, options);
    } finally {
      if (ownsDescriptor) fs.closeSync(descriptor);
    }
  };
  try {
    process.stdout.write(
      resolveTokenEncryptionKey(credentialsDir, {}).toString("hex"),
    );
  } catch (error) {
    // error-policy:J1 expose typed key-resolution failures to the parent harness.
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      typeof error.code !== "string" ||
      !(error.cause instanceof Error)
    ) {
      throw error;
    }
    process.stderr.write(
      `${JSON.stringify({
        phase: "resolve-token-encryption-key",
        code: error.code,
        message: error.message,
        cause: { name: error.cause.name, message: error.cause.message },
      })}\n`,
    );
    process.exitCode = 1;
  } finally {
    fs.writeFileSync = originalWrite;
  }
} else {
  fs.writeFileSync(path.join(credentialsDir, `ready-${participant}`), "");
  await waitForStart();
  process.stdout.write(
    resolveTokenEncryptionKey(credentialsDir, {}).toString("hex"),
  );
}
