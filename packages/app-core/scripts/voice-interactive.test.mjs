/** Exercises voice interactive behavior with deterministic app-core test fixtures. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstalledBundleRoot } from "./voice-interactive.mjs";

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "voice-interactive-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("resolveInstalledBundleRoot", () => {
  const catalogEntry = {
    id: "eliza-1-2b",
    ggufFile: "text/eliza-1-2b-128k.gguf",
  };

  it("rejects placeholder bundle directories that do not contain the primary text GGUF", async () => {
    const modelsDir = await makeTempDir();
    await mkdir(path.join(modelsDir, "eliza-1-2b.bundle"), {
      recursive: true,
    });

    const resolved = resolveInstalledBundleRoot(catalogEntry, modelsDir);

    expect(resolved).toMatchObject({
      bundleRoot: null,
      reason: "missing-text-gguf",
      expectedPath: path.join(
        modelsDir,
        "eliza-1-2b.bundle",
        "text",
        "eliza-1-2b-128k.gguf",
      ),
    });
  });

  it("accepts a bundle only when the catalog primary text GGUF is present", async () => {
    const modelsDir = await makeTempDir();
    const bundleRoot = path.join(modelsDir, "eliza-1-2b.bundle");
    const textPath = path.join(bundleRoot, "text", "eliza-1-2b-128k.gguf");
    await mkdir(path.dirname(textPath), { recursive: true });
    await writeFile(textPath, "gguf placeholder");

    const resolved = resolveInstalledBundleRoot(catalogEntry, modelsDir);

    expect(resolved).toEqual({
      bundleRoot,
      textPath,
    });
  });
});
