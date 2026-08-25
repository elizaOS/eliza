/**
 * Verifies the real AI-QA reviewer entrypoints reject ambiguous CLI input
 * before credential checks while preserving their valid keyless path.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseReviewerArgs } from "../../../../scripts/ai-qa/reviewer-args.mjs";

const reviewerScripts = [
  {
    label: "screenshot reviewer",
    supportsVerdictMd: false,
    path: resolve(
      import.meta.dirname,
      "../../../../scripts/ai-qa/review-screenshots.mjs",
    ),
  },
  {
    label: "walkthrough reviewer",
    supportsVerdictMd: true,
    path: resolve(
      import.meta.dirname,
      "../../../../scripts/ai-qa/review-walkthrough.mjs",
    ),
  },
];

const {
  AI_QA_VISION_BACKEND: _backend,
  ANTHROPIC_API_KEY: _anthropicKey,
  OPENAI_API_KEY: _openAiKey,
  ...keylessEnvironment
} = process.env;
const temporaryRoot = mkdtempSync(resolve(tmpdir(), "ai-qa-reviewer-args-"));

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("AI-QA reviewer arguments", () => {
  it("preserves defaults and supported screenshot options", () => {
    expect(parseReviewerArgs([])).toEqual({
      runDir: null,
      concurrency: 4,
      strict: false,
    });
    expect(
      parseReviewerArgs([
        "--run-dir",
        "reports/example",
        "--concurrency",
        "8",
        "--strict",
      ]),
    ).toEqual({
      runDir: "reports/example",
      concurrency: 8,
      strict: true,
    });
    expect(() => parseReviewerArgs(["--update-debt"])).toThrow(
      "unknown argument: --update-debt",
    );
  });

  it("supports the walkthrough-only verdict destination", () => {
    expect(
      parseReviewerArgs(["--verdict-md", "reports/verdict.md"], {
        defaultVerdictMd: "default.md",
      }).verdictMd,
    ).toBe("reports/verdict.md");
    expect(() =>
      parseReviewerArgs(["--verdict-md", "reports/verdict.md"]),
    ).toThrow("unknown argument: --verdict-md");
  });

  it.each([
    [["--strcit"], "unknown argument: --strcit"],
    [["positional"], "unknown argument: positional"],
    [["--strict", "--strict"], "--strict may be specified only once"],
    [["--strict", "--update-debt"], "unknown argument: --update-debt"],
    [["--update-debt", "--strict"], "unknown argument: --update-debt"],
    [
      ["--concurrency", "2", "--concurrency", "3"],
      "--concurrency may be specified only once",
    ],
    [["--run-dir"], "--run-dir requires a value"],
    [["--run-dir", "--strict"], "--run-dir requires a value"],
    [["--run-dir", "-strict"], "--run-dir requires a value"],
    [["--concurrency"], "--concurrency requires a value"],
    [["--concurrency", "--strict"], "--concurrency requires a value"],
  ])("rejects ambiguous arguments %j", (argv, message) => {
    expect(() => parseReviewerArgs(argv)).toThrow(message);
  });

  it("rejects flag-shaped walkthrough verdict values", () => {
    expect(() =>
      parseReviewerArgs(["--verdict-md", "-strict"], {
        defaultVerdictMd: "default.md",
      }),
    ).toThrow("--verdict-md requires a value");
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])(
    "rejects invalid concurrency %j",
    (value) => {
      expect(() => parseReviewerArgs(["--concurrency", value])).toThrow(
        "--concurrency must be a positive safe integer",
      );
    },
  );

  it.each(reviewerScripts)(
    "rejects a misspelled strict flag at the real $label boundary",
    ({ path }) => {
      const result = spawnSync(process.execPath, [path, "--strcit"], {
        encoding: "utf8",
        env: keylessEnvironment,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unknown argument: --strcit");
      expect(result.stdout).not.toContain("skipping");
      expect(result.stdout).not.toContain("PASSED");
    },
  );

  it.each(reviewerScripts)(
    "rejects a flag-shaped value at the real $label boundary",
    ({ path }) => {
      const result = spawnSync(
        process.execPath,
        [path, "--run-dir", "-strict"],
        {
          encoding: "utf8",
          env: keylessEnvironment,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--run-dir requires a value");
      expect(result.stdout).not.toContain("skipping");
      expect(result.stdout).not.toContain("PASSED");
    },
  );

  it.each(reviewerScripts)(
    "preserves the valid keyless skip for the $label",
    ({ path }) => {
      const result = spawnSync(process.execPath, [path, "--strict"], {
        encoding: "utf8",
        env: keylessEnvironment,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("skipping");
      expect(result.stderr).toBe("");
    },
  );
});
