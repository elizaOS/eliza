import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listInstalledModels,
  removeElizaModel,
  touchElizaModel,
  upsertElizaModel,
} from "./registry";
import type { InstalledModel } from "./types";

describe("registry", () => {
  let tmpRoot: string;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-registry-"));
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

  async function makeFile(relative: string, bytes = 100): Promise<string> {
    const full = path.join(tmpRoot, "local-inference", "models", relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.alloc(bytes, 0x42));
    return full;
  }

  function makeOwned(
    id: string,
    filePath: string,
    extra: Partial<InstalledModel> = {},
  ): InstalledModel {
    return {
      id,
      displayName: id,
      path: filePath,
      sizeBytes: 100,
      installedAt: new Date().toISOString(),
      lastUsedAt: null,
      source: "eliza-download",
      ...extra,
    };
  }

  it("upsert then list returns the model", async () => {
    const file = await makeFile("a.gguf");
    await upsertElizaModel(makeOwned("a", file));
    const list = await listInstalledModels();
    expect(list.some((m) => m.id === "a")).toBe(true);
  });

  it("rejects upsert of a file outside the eliza root", async () => {
    await expect(
      upsertElizaModel(makeOwned("a", "/etc/passwd")),
    ).rejects.toThrow(/under the local-inference root/);
  });

  it("rejects upsert of non-eliza-download source", async () => {
    const file = await makeFile("x.gguf");
    await expect(
      upsertElizaModel({
        ...makeOwned("x", file),
        source: "external-scan",
      }),
    ).rejects.toThrow(/only accepts Eliza-owned models/);
  });

  it("upsert of same id replaces the entry", async () => {
    const file = await makeFile("rep.gguf");
    await upsertElizaModel(makeOwned("rep", file));
    await upsertElizaModel(makeOwned("rep", file, { displayName: "renamed" }));
    const list = await listInstalledModels();
    const entry = list.find((m) => m.id === "rep");
    expect(entry?.displayName).toBe("renamed");
    // Exactly one copy.
    expect(list.filter((m) => m.id === "rep").length).toBe(1);
  });

  it("touchElizaModel updates lastUsedAt", async () => {
    const file = await makeFile("t.gguf");
    await upsertElizaModel(makeOwned("t", file));
    await touchElizaModel("t");
    const list = await listInstalledModels();
    const entry = list.find((m) => m.id === "t");
    expect(entry?.lastUsedAt).not.toBeNull();
  });

  it("removeElizaModel deletes the file and the registry entry", async () => {
    const file = await makeFile("rm.gguf");
    await upsertElizaModel(makeOwned("rm", file));
    const result = await removeElizaModel("rm");
    expect(result.removed).toBe(true);
    const list = await listInstalledModels();
    expect(list.some((m) => m.id === "rm")).toBe(false);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("removeElizaModel returns not-found for unknown ids", async () => {
    const result = await removeElizaModel("unknown");
    expect(result).toEqual({ removed: false, reason: "not-found" });
  });
});
