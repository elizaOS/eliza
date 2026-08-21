/** Exercises binary staging discovery without invoking a shell or the publishing CLI. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagingDirHasBinary } from "./voice-models-publish-all.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("voice staging binary discovery", () => {
  test("finds supported binary payloads through a deep path", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-voice-staging-"));
    roots.push(root);
    const nested = join(root, "dir with shell metacharacters $() ;", "deeper");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "model.gguf"), "fixture");

    expect(stagingDirHasBinary(root)).toBe(true);
  });

  test("rejects unsupported files and unreadable paths", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-voice-staging-"));
    roots.push(root);
    writeFileSync(join(root, "README.md"), "fixture");

    expect(stagingDirHasBinary(root)).toBe(false);
    expect(stagingDirHasBinary(join(root, "missing"))).toBe(false);
  });
});
