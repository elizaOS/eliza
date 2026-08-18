/**
 * Shared helpers for the extension build/packaging scripts: a promisified
 * child-process `run` and small fs utilities.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const REPRODUCIBLE_ARCHIVE_TIMESTAMP = new Date("2020-01-01T00:00:00.000Z");

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

export async function findFileWithExtension(directory, extension) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.name.endsWith(extension)) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = await findFileWithExtension(fullPath, extension);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

export async function normalizeTreeTimestamps(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeTreeTimestamps(entryPath);
    }
    await fs.utimes(
      entryPath,
      REPRODUCIBLE_ARCHIVE_TIMESTAMP,
      REPRODUCIBLE_ARCHIVE_TIMESTAMP,
    );
  }
  await fs.utimes(
    directory,
    REPRODUCIBLE_ARCHIVE_TIMESTAMP,
    REPRODUCIBLE_ARCHIVE_TIMESTAMP,
  );
}

export async function writeSha256Sidecar(filePath) {
  const digest = createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
  await fs.writeFile(
    `${filePath}.sha256`,
    `${digest}  ${path.basename(filePath)}\n`,
  );
  return digest;
}
