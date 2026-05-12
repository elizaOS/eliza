import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRecommendedAssignments,
  ensureDefaultAssignment,
  readAssignments,
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
      installed("eliza-1-1_7b", 1_000, {
        bundleVerifiedAt: "2026-05-11T01:00:00.000Z",
      }),
    ]);

    expect(assignments).toEqual({
      TEXT_SMALL: "eliza-1-1_7b",
      TEXT_LARGE: "eliza-1-1_7b",
    });
  });

  it("does not auto-recommend unverified Eliza-1 downloads", () => {
    const assignments = buildRecommendedAssignments([
      installed("eliza-1-1_7b", 1_000),
    ]);

    expect(assignments).toEqual({});
  });

  it("does not fill defaults for custom Hugging Face model ids", async () => {
    process.env.ELIZA_STATE_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-assignments-test-"),
    );

    await ensureDefaultAssignment("hf:some-org/some-model::model.Q4_K_M.gguf");

    expect(await readAssignments()).toEqual({});
  });
});
