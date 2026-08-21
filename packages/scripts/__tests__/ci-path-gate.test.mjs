/**
 * Verifies the shared CI classifier parses Git's NUL-delimited changed-path
 * inventory without losing rename endpoints or unusual valid filenames, and
 * that the centralized classifier workflow path triggers every consumer lane.
 */
import { describe, expect, it } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { CONFIGS, evaluate, parseGitNameStatus } from "../ci-path-gate.mjs";

const CLASSIFIER_PATH = ".github/workflows/classify-paths.yml";
const DEVELOP_PUSH_WRAPPER_PATH = ".github/workflows/ci-develop-push.yml";
const tmpFile = `${import.meta.dir}/.tmp-classifier-only-diff`;

/**
 * The reusable classifier workflow must never self-skip. Before #14051 Tier B,
 * each consumer workflow inlined ci-path-gate.mjs and referenced itself by
 * path, so a change to the inline classifier always re-triggered every lane it
 * gated. After consolidation into classify-paths.yml, that workflow path was
 * missing from every CONFIGS rule set — a classifier-only diff returned all
 * lanes false, letting a change to the routing/output contract skip every
 * consumer (#14051 review round 2, P1 finding). This test proves the fix.
 */
describe("classifier self-registration regression", () => {
  it("test config triggers all seven lanes for a develop-push wrapper diff", () => {
    writeFileSync(tmpFile, `${DEVELOP_PUSH_WRAPPER_PATH}\n`);
    try {
      const result = evaluate(CONFIGS.test, {
        eventName: "pull_request",
        labels: "",
        changedFilesPath: tmpFile,
      });
      for (const lane of CONFIGS.test.outputs) {
        expect(result.matchesByLane.get(lane).length).toBeGreaterThan(0);
      }
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("test config triggers all seven lanes for a classifier-only diff", () => {
    writeFileSync(tmpFile, `${CLASSIFIER_PATH}\n`);
    try {
      const result = evaluate(CONFIGS.test, {
        eventName: "pull_request",
        labels: "",
        changedFilesPath: tmpFile,
      });
      for (const lane of CONFIGS.test.outputs) {
        expect(result.matchesByLane.get(lane).length).toBeGreaterThan(0);
      }
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("scenario-pr config triggers its lane for a classifier-only diff", () => {
    writeFileSync(tmpFile, `${CLASSIFIER_PATH}\n`);
    try {
      const result = evaluate(CONFIGS["scenario-pr"], {
        eventName: "pull_request",
        labels: "",
        changedFilesPath: tmpFile,
      });
      expect(
        result.matchesByLane.get("run_scenario_pr").length,
      ).toBeGreaterThan(0);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("docker config triggers its lane for a classifier-only diff", () => {
    writeFileSync(tmpFile, `${CLASSIFIER_PATH}\n`);
    try {
      const result = evaluate(CONFIGS.docker, {
        eventName: "pull_request",
        labels: "",
        changedFilesPath: tmpFile,
      });
      expect(result.matchesByLane.get("docker").length).toBeGreaterThan(0);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("dev-smoke config triggers its lane for a classifier-only diff", () => {
    writeFileSync(tmpFile, `${CLASSIFIER_PATH}\n`);
    try {
      const result = evaluate(CONFIGS["dev-smoke"], {
        eventName: "pull_request",
        labels: "",
        changedFilesPath: tmpFile,
      });
      expect(result.matchesByLane.get("dev_smoke").length).toBeGreaterThan(0);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe("parseGitNameStatus", () => {
  it("returns an empty inventory for an empty diff", () => {
    expect(parseGitNameStatus("")).toEqual([]);
  });

  it("parses ordinary add, delete, modify, and type-change records", () => {
    expect(
      parseGitNameStatus(
        [
          "A",
          "added.ts",
          "D",
          "deleted.ts",
          "M",
          "modified.ts",
          "T",
          "type-changed.ts",
          "",
        ].join("\0"),
      ),
    ).toEqual(["added.ts", "deleted.ts", "modified.ts", "type-changed.ts"]);
  });

  it("includes both endpoints for renames and copies", () => {
    expect(
      parseGitNameStatus(
        [
          "R100",
          "packages/app/src/covered.ts",
          "packages/docs/covered.ts",
          "C75",
          "packages/core/src/source.ts",
          "packages/shared/src/copied.ts",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      "packages/app/src/covered.ts",
      "packages/docs/covered.ts",
      "packages/core/src/source.ts",
      "packages/shared/src/copied.ts",
    ]);
  });

  it("preserves spaces, tabs, and newlines inside paths", () => {
    const unusual = "packages/app/src/space tab\tline\nbreak.ts";
    expect(parseGitNameStatus(["A", unusual, ""].join("\0"))).toEqual([
      unusual,
    ]);
  });

  it("deduplicates paths while retaining first-seen order", () => {
    expect(
      parseGitNameStatus(
        ["M", "same.ts", "R100", "same.ts", "moved.ts", ""].join("\0"),
      ),
    ).toEqual(["same.ts", "moved.ts"]);
  });

  it("fails closed on unsupported or truncated records", () => {
    expect(() => parseGitNameStatus("Z\0mystery.ts\0")).toThrow(
      /unsupported git diff status/,
    );
    expect(() => parseGitNameStatus("R100\0source.ts\0")).toThrow(
      /malformed git diff record/,
    );
    expect(() => parseGitNameStatus("M")).toThrow(/malformed git diff record/);
  });
});
