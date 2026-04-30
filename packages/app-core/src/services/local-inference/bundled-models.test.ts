import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBundledModels } from "./bundled-models";
import { listInstalledModels } from "./registry";

describe("registerBundledModels", () => {
  let tmpRoot: string;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "milady-bundled-"));
    originalStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = tmpRoot;
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalStateDir;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeManifest(
    models: Array<{
      id: string;
      displayName: string;
      hfRepo: string;
      ggufFile: string;
      role: "chat" | "embedding";
      sizeBytes: number;
      sha256: string | null;
    }>,
  ): Promise<void> {
    const dir = path.join(tmpRoot, "local-inference", "models");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ version: 1, models }),
      "utf8",
    );
  }

  async function writeFakeGguf(name: string, bytes = 1024): Promise<string> {
    const dir = path.join(tmpRoot, "local-inference", "models");
    await fs.mkdir(dir, { recursive: true });
    const full = path.join(dir, name);
    await fs.writeFile(full, Buffer.alloc(bytes, 0x44));
    return full;
  }

  it("returns 0 when no manifest is present (Capacitor / desktop install)", async () => {
    const count = await registerBundledModels();
    expect(count).toBe(0);
  });

  it("registers manifest entries that have matching files on disk", async () => {
    const ggufPath = await writeFakeGguf("smol.gguf", 2048);
    await writeManifest([
      {
        id: "smol-test",
        displayName: "Smol Test",
        hfRepo: "fake/repo",
        ggufFile: "smol.gguf",
        role: "chat",
        sizeBytes: 2048,
        sha256: "abcd",
      },
    ]);
    const count = await registerBundledModels();
    expect(count).toBe(1);
    const installed = await listInstalledModels();
    const entry = installed.find((m) => m.id === "smol-test");
    expect(entry).toBeDefined();
    expect(entry?.path).toBe(ggufPath);
    expect(entry?.source).toBe("milady-download");
    expect(entry?.sizeBytes).toBe(2048);
    expect(entry?.sha256).toBe("abcd");
  });

  it("skips manifest entries that have no extracted file", async () => {
    await writeManifest([
      {
        id: "missing-model",
        displayName: "Missing",
        hfRepo: "fake/missing",
        ggufFile: "missing.gguf",
        role: "chat",
        sizeBytes: 1024,
        sha256: null,
      },
    ]);
    const count = await registerBundledModels();
    expect(count).toBe(0);
    const installed = await listInstalledModels();
    expect(installed.some((m) => m.id === "missing-model")).toBe(false);
  });

  it("re-running is idempotent — second call leaves the registry unchanged", async () => {
    await writeFakeGguf("smol.gguf", 2048);
    await writeManifest([
      {
        id: "smol-test",
        displayName: "Smol Test",
        hfRepo: "fake/repo",
        ggufFile: "smol.gguf",
        role: "chat",
        sizeBytes: 2048,
        sha256: "abcd",
      },
    ]);
    await registerBundledModels();
    const first = await listInstalledModels();
    await registerBundledModels();
    const second = await listInstalledModels();
    expect(second.length).toBe(first.length);
    expect(second.find((m) => m.id === "smol-test")?.path).toBe(
      first.find((m) => m.id === "smol-test")?.path,
    );
  });
});
