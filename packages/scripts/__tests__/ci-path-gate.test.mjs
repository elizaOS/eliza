/**
 * Verifies the shared CI classifier parses Git's NUL-delimited changed-path
 * inventory without losing rename endpoints or unusual valid filenames, and
 * that the centralized classifier workflow path triggers every consumer lane.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { CONFIGS, evaluate, parseGitNameStatus } from "../ci-path-gate.mjs";

const CLASSIFIER_PATH = ".github/workflows/classify-paths.yml";
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

describe("synthetic-world hosted test routing", () => {
  it("routes package changes to the server lane that runs its transaction suite", () => {
    writeFileSync(tmpFile, "packages/synthetic-world/src/command-journal.ts\n");
    try {
      const result = evaluate(CONFIGS.test, {
        eventName: "pull_request",
        labels: "",
        changedFilesPath: tmpFile,
      });
      expect(
        result.matchesByLane
          .get("server")
          .some(
            (match) =>
              match.kind === "path" &&
              match.path === "packages/synthetic-world/src/command-journal.ts",
          ),
      ).toBe(true);
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

/**
 * A gate pattern that matches nothing on disk is silently inert: the lane it
 * was meant to trigger simply never sees that surface. That is how
 * `.github/workflows/classify-paths.yml` itself went unregistered above, and
 * how `packages/app-core/scripts/docker-healthcheck.mjs` — a path that never
 * existed in this repository — survived in the docker rule from the
 * half-landed workflow consolidation (59ffb5ef60) until it was removed.
 *
 * So every pattern must resolve against the tracked tree. Patterns that
 * deliberately anticipate a file the repo does not have yet go in the
 * allowlist below, with the reason: naming a specific nonexistent file is a
 * stale reference, while a conventional config glob is forward-looking.
 */
const PATTERNS_WITHOUT_TRACKED_MATCHES = new Map([
  [
    "vite.config.*",
    "No root vite.config.* exists today; the scenario-pr toolchain rule keeps it so one added later triggers the lane without a gate edit. Root vitest.config.ts is matched by the sibling vitest.config.* pattern.",
  ],
]);

function trackedFiles() {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean);
}

/** Mirrors ci-path-gate.mjs's own glob translation. */
function patternToRegExp(pattern) {
  const sentinel = "\0";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, sentinel)
    .replace(/\*/g, "[^/]*")
    .replaceAll(sentinel, "[\\s\\S]*");
  return new RegExp(`^${escaped}$`);
}

function allPatterns() {
  const entries = [];
  for (const [configName, config] of Object.entries(CONFIGS)) {
    const groups = [...(config.rules ?? [])];
    if (config.failSafe) groups.push(config.failSafe);
    for (const rule of groups) {
      for (const pattern of rule.patterns ?? []) {
        entries.push({
          configName,
          pattern,
          reason: rule.reason ?? "fail-safe",
        });
      }
    }
  }
  return entries;
}

describe("gate patterns resolve against the tracked tree", () => {
  it("matches at least one tracked file for every pattern", () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(1_000);

    const inert = [];
    for (const { configName, pattern, reason } of allPatterns()) {
      if (PATTERNS_WITHOUT_TRACKED_MATCHES.has(pattern)) continue;
      const regExp = patternToRegExp(pattern);
      if (!files.some((file) => regExp.test(file))) {
        inert.push(`${configName}: ${pattern} (${reason})`);
      }
    }

    expect(inert).toEqual([]);
  }, 120_000);

  it("keeps the allowlist honest by dropping entries that start matching", () => {
    const files = trackedFiles();
    const known = new Set(allPatterns().map((entry) => entry.pattern));

    for (const [pattern, why] of PATTERNS_WITHOUT_TRACKED_MATCHES) {
      expect(
        known.has(pattern),
        `${pattern} is allowlisted but no rule uses it`,
      ).toBe(true);
      expect(why.length).toBeGreaterThan(20);
      const regExp = patternToRegExp(pattern);
      expect(
        files.some((file) => regExp.test(file)),
        `${pattern} now matches a tracked file; remove it from the allowlist`,
      ).toBe(false);
    }
  }, 120_000);
});
