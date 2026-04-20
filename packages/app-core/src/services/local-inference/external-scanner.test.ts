import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanExternalModels } from "./external-scanner";

/**
 * Redirects the scanner by overriding `$HOME` — `os.homedir()` honours
 * that env on POSIX systems. Real filesystem, real walk, real manifest
 * parsing — no mocks.
 */

describe("scanExternalModels", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "milady-scan-home-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("finds flat .gguf files under LM Studio", async () => {
    const lmsDir = path.join(tmpHome, ".lmstudio", "models", "org", "model");
    await fs.mkdir(lmsDir, { recursive: true });
    const file = path.join(lmsDir, "Qwen2.5-7B-Instruct-Q4_K_M.gguf");
    await fs.writeFile(file, Buffer.alloc(64));
    const found = await scanExternalModels();
    const match = found.find((m) => m.path === file);
    expect(match).toBeDefined();
    expect(match?.externalOrigin).toBe("lm-studio");
    expect(match?.source).toBe("external-scan");
  });

  it("parses Ollama's manifest→blob mapping", async () => {
    const ollamaRoot = path.join(tmpHome, ".ollama", "models");
    const manifests = path.join(
      ollamaRoot,
      "manifests",
      "registry.ollama.ai",
      "library",
      "llama3.2",
    );
    const blobs = path.join(ollamaRoot, "blobs");
    await fs.mkdir(manifests, { recursive: true });
    await fs.mkdir(blobs, { recursive: true });
    const digest = `sha256:${"b".repeat(64)}`; // JSON-style
    const blobFile = path.join(blobs, digest.replace("sha256:", "sha256-"));
    await fs.writeFile(blobFile, Buffer.alloc(256));
    await fs.writeFile(
      path.join(manifests, "3b"),
      JSON.stringify({
        layers: [
          {
            mediaType: "application/vnd.ollama.image.model",
            digest,
            size: 256,
          },
        ],
      }),
    );

    const found = await scanExternalModels();
    const match = found.find((m) => m.path === blobFile);
    expect(match).toBeDefined();
    expect(match?.externalOrigin).toBe("ollama");
    expect(match?.sizeBytes).toBe(256);
    expect(match?.displayName).toContain("ollama:");
  });

  it("returns an empty list when no tools have cached anything", async () => {
    const found = await scanExternalModels();
    expect(found).toEqual([]);
  });

  it("dedupes by real path — a file appearing under two roots reports once", async () => {
    // HF cache stores the real blob under blobs/ and a symlink under snapshots/.
    const hfRoot = path.join(tmpHome, ".cache", "huggingface", "hub");
    const snap = path.join(
      hfRoot,
      "models--org--repo",
      "snapshots",
      "deadbeef",
    );
    const blob = path.join(hfRoot, "models--org--repo", "blobs");
    await fs.mkdir(snap, { recursive: true });
    await fs.mkdir(blob, { recursive: true });
    const realFile = path.join(blob, "abc.gguf");
    await fs.writeFile(realFile, Buffer.alloc(64));
    await fs.symlink(realFile, path.join(snap, "model.gguf"));

    const found = await scanExternalModels();
    const matches = found.filter((m) => m.path === realFile);
    expect(matches.length).toBe(1);
  });
});
