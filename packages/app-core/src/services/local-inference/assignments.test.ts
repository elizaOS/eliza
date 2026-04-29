import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRecommendedAssignments,
  readAssignments,
  setAssignment,
  writeAssignments,
} from "./assignments";
import type { InstalledModel } from "./types";

describe("assignments", () => {
  let tmpRoot: string;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "milady-assign-"));
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

  it("returns {} when no file exists yet", async () => {
    expect(await readAssignments()).toEqual({});
  });

  it("round-trips through writeAssignments", async () => {
    await writeAssignments({
      TEXT_SMALL: "llama-3.2-1b",
      TEXT_LARGE: "qwen2.5-7b",
    });
    expect(await readAssignments()).toEqual({
      TEXT_SMALL: "llama-3.2-1b",
      TEXT_LARGE: "qwen2.5-7b",
    });
  });

  it("setAssignment merges into existing slots", async () => {
    await writeAssignments({ TEXT_SMALL: "a" });
    const next = await setAssignment("TEXT_LARGE", "b");
    expect(next).toEqual({ TEXT_SMALL: "a", TEXT_LARGE: "b" });
  });

  it("setAssignment with null clears the slot", async () => {
    await writeAssignments({ TEXT_SMALL: "a", TEXT_LARGE: "b" });
    const next = await setAssignment("TEXT_SMALL", null);
    expect(next).toEqual({ TEXT_LARGE: "b" });
  });

  it("returns {} for an unreadable or malformed file", async () => {
    await fs.mkdir(path.join(tmpRoot, "local-inference"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "local-inference", "assignments.json"),
      "not json",
      "utf8",
    );
    expect(await readAssignments()).toEqual({});
  });

  it("ignores files with unknown version", async () => {
    await fs.mkdir(path.join(tmpRoot, "local-inference"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "local-inference", "assignments.json"),
      JSON.stringify({ version: 99, assignments: { TEXT_SMALL: "x" } }),
      "utf8",
    );
    expect(await readAssignments()).toEqual({});
  });

  it("recommends the largest installed local model for both text routes", () => {
    const installed: InstalledModel[] = [
      {
        id: "small-local",
        displayName: "Small Local",
        path: "/models/small.gguf",
        sizeBytes: 2_000,
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
        source: "external-scan",
      },
      {
        id: "large-local",
        displayName: "Large Local",
        path: "/models/large.gguf",
        sizeBytes: 8_000,
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
        source: "external-scan",
      },
    ];

    expect(buildRecommendedAssignments(installed)).toEqual({
      TEXT_LARGE: "large-local",
      TEXT_SMALL: "large-local",
    });
  });
});
