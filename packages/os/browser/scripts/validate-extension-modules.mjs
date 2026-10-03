/** Compile the staged worker graph without executing it or shipping a second bundle. */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function validateExtensionModules(directory) {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "eliza-extension-graph-"),
  );
  try {
    const result = spawnSync(
      "bun",
      [
        "build",
        path.join(directory, "background.mjs"),
        "--target=browser",
        `--outfile=${path.join(temporary, "worker.js")}`,
      ],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Staged extension module graph is invalid: ${result.stderr || result.stdout}`,
      );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
