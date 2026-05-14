import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

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
