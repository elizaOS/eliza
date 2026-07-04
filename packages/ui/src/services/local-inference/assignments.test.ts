/**
 * Unit coverage for model slot assignments: recommended defaults, read/write, and
 * ensure-default. Temp-dir filesystem, no engine.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRecommendedAssignments,
  ensureDefaultAssignment,
  readAssignments,
  setAssignment,
  writeAssignments,
} from "./assignments";
import type { InstalledModel } from "./types";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function installed(
  id: string,
  sizeBytes: number,
  overrides: Partial<InstalledModel> = {},
): InstalledModel {
  return {
    id,
    displayName: id,
    path: `/tmp/${id}.gguf`,
    sizeBytes,
    installedAt: "2026-05-11T00:00:00.000Z",
    lastUsedAt: null,
    source: "eliza-download",
    ...overrides,
  };
}

describe("local inference assignments", () => {
  it("does not auto-recommend ad-hoc Hugging Face downloads", () => {
    const assignments = buildRecommendedAssignments([
      installed("hf:some-org/some-model::model.Q4_K_M.gguf", 10_000),
      installed("eliza-1-2b", 1_000, {
        bundleVerifiedAt: "2026-05-11T01:00:00.000Z",
      }),
    ]);

    expect(assignments).toEqual({
      TEXT_SMALL: "eliza-1-2b",
      TEXT_LARGE: "eliza-1-2b",
      TEXT_TO_SPEECH: "eliza-1-2b",
      TRANSCRIPTION: "eliza-1-2b",
    });
  });

  it("does not auto-recommend unverified Eliza-1 bundles", () => {
    const assignments = buildRecommendedAssignments([
      installed("eliza-1-2b", 1_000),
      installed("eliza-1-4b", 2_000, {
        bundleVerifiedAt: "2026-05-11T01:00:00.000Z",
      }),
    ]);

    expect(assignments).toEqual({
      TEXT_SMALL: "eliza-1-4b",
      TEXT_LARGE: "eliza-1-4b",
      TEXT_TO_SPEECH: "eliza-1-4b",
      TRANSCRIPTION: "eliza-1-4b",
    });
  });

  it("does not fill defaults for custom Hugging Face model ids", async () => {
    process.env.ELIZA_STATE_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-assignments-test-"),
    );

    await ensureDefaultAssignment("hf:some-org/some-model::model.Q4_K_M.gguf");

    expect(await readAssignments()).toEqual({});
  });

  it("rejects custom assignment writes", async () => {
    process.env.ELIZA_STATE_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-assignments-test-"),
    );

    await expect(
      setAssignment("TEXT_LARGE", "hf:some-org/some-model::model.Q4_K_M.gguf"),
    ).rejects.toThrow(/curated Eliza-1/i);
    expect(await readAssignments()).toEqual({});
  });

  it("drops stale custom ids while preserving curated assignments", async () => {
    process.env.ELIZA_STATE_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-assignments-test-"),
    );

    await writeAssignments({
      TEXT_SMALL: "eliza-1-4b",
      TEXT_LARGE: "hf:some-org/some-model::model.Q4_K_M.gguf",
    });

    expect(await readAssignments()).toEqual({ TEXT_SMALL: "eliza-1-4b" });
  });
});
