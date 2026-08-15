/** Exercises working-directory changes against the real process boundary. */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCwd, setCwd } from "./cwd.js";

const originalCwd = process.cwd();
const temporaryDirectories: string[] = [];

afterAll(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("working directory", () => {
  it("resolves absolute and relative directory changes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "eliza-code-cwd-"));
    temporaryDirectories.push(parent);
    const child = await mkdtemp(join(parent, "child-"));

    expect(await setCwd(parent)).toEqual({ success: true, path: parent });
    expect(await setCwd(child.slice(parent.length + 1))).toEqual({
      success: true,
      path: child,
    });
    expect(getCwd()).toBe(child);
  });

  it("returns a failure without changing the tracked directory", async () => {
    const before = getCwd();
    const result = await setCwd("missing-directory");

    expect(result.success).toBe(false);
    expect(result.path).toBe(join(before, "missing-directory"));
    expect(result.error).toBeString();
    expect(getCwd()).toBe(before);
  });
});
