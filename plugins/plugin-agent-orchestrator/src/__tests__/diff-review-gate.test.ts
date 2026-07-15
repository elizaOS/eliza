import { describe, expect, it } from "vitest";
import {
  type DiffGateResult,
  reviewDiff,
  summarizeDiffGate,
} from "../services/diff-review-gate.js";

/** Build a minimal unified-diff hunk that ADDS the given lines to a file. */
function addedFileDiff(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    "@@ -0,0 +1,%d @@",
    ...lines.map((l) => `+${l}`),
  ].join("\n");
}

const openAiTestKey = () => ["sk", "abcdefghijklmnop1234567890"].join("-");
const githubTestPat = () =>
  ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_");

describe("reviewDiff — allowed diff passes untouched", () => {
  it("passes a clean source-only diff with no findings", () => {
    const diff = addedFileDiff("src/app.ts", [
      "export function add(a: number, b: number) {",
      "  return a + b;",
      "}",
    ]);
    const result = reviewDiff({
      diff,
      changedFiles: ["src/app.ts"],
    });
    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.blocking).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(summarizeDiffGate(result)).toBe("");
  });

  it("does not flag a removed-line secret (pre-existing debt, not introduced)", () => {
    // A secret that only appears on a REMOVED (`-`) line is being deleted, not
    // introduced — the gate must not block a PR for removing a secret.
    const diff = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,2 +1,1 @@",
      `-const OPENAI_API_KEY = "${openAiTestKey()}";`,
      "+// key moved to env",
    ].join("\n");
    const result = reviewDiff({ diff, changedFiles: ["src/config.ts"] });
    expect(result.passed).toBe(true);
    expect(result.blocking).toHaveLength(0);
  });
});

describe("reviewDiff — secret detection blocks", () => {
  it("blocks on an added OpenAI-style key", () => {
    const diff = addedFileDiff("src/config.ts", [
      `const key = "${openAiTestKey()}";`,
    ]);
    const result = reviewDiff({ diff, changedFiles: ["src/config.ts"] });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "secret")).toBe(true);
  });

  it("blocks on an ENV-style credential assignment", () => {
    const diff = addedFileDiff(".env.example", [
      "DATABASE_PASSWORD=hunter2hunter2hunter2",
    ]);
    const result = reviewDiff({ diff, changedFiles: [".env.example"] });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "secret")).toBe(true);
  });

  it("blocks on a GitHub PAT and never echoes the secret value", () => {
    const secret = githubTestPat();
    const diff = addedFileDiff("src/token.ts", [`const t = "${secret}";`]);
    const result = reviewDiff({ diff, changedFiles: ["src/token.ts"] });
    expect(result.passed).toBe(false);
    const secretFinding = result.blocking.find((f) => f.check === "secret");
    expect(secretFinding).toBeDefined();
    // The finding must NOT contain the full secret (redacted fingerprint only).
    expect(secretFinding?.message.includes(secret)).toBe(false);
    expect(summarizeDiffGate(result).includes(secret)).toBe(false);
    expect(secretFinding?.message).not.toContain(secret.slice(0, 12));
    expect(secretFinding?.message).toMatch(/sha256:[a-f0-9]{12}/);
  });

  it("dedupes identical secret lines into a single finding", () => {
    const line = `const k = "${openAiTestKey()}";`;
    const diff = addedFileDiff("src/a.ts", [line, line, line]);
    const result = reviewDiff({ diff, changedFiles: ["src/a.ts"] });
    const secretFindings = result.blocking.filter((f) => f.check === "secret");
    expect(secretFindings).toHaveLength(1);
  });
});

describe("reviewDiff — forbidden-file blocks", () => {
  it("blocks a lockfile change", () => {
    const diff = addedFileDiff("bun.lock", ['  "foo": "1.0.0"']);
    const result = reviewDiff({ diff, changedFiles: ["bun.lock"] });
    expect(result.passed).toBe(false);
    const finding = result.blocking.find((f) => f.check === "forbidden-file");
    expect(finding?.file).toBe("bun.lock");
  });

  it("blocks a build-config file (vite.config.ts)", () => {
    const diff = addedFileDiff("vite.config.ts", ["export default {}"]);
    const result = reviewDiff({ diff, changedFiles: ["vite.config.ts"] });
    expect(result.passed).toBe(false);
    expect(
      result.blocking.some(
        (f) => f.check === "forbidden-file" && f.file === "vite.config.ts",
      ),
    ).toBe(true);
  });

  it("blocks index.html", () => {
    const result = reviewDiff({
      diff: addedFileDiff("index.html", ["<html></html>"]),
      changedFiles: ["index.html"],
    });
    expect(result.passed).toBe(false);
  });

  it("blocks a binary artifact by extension", () => {
    const result = reviewDiff({
      diff: "",
      changedFiles: ["assets/logo.png"],
    });
    expect(result.passed).toBe(false);
    expect(
      result.blocking.some(
        (f) => f.check === "forbidden-file" && f.file === "assets/logo.png",
      ),
    ).toBe(true);
  });

  it("blocks a nested lockfile regardless of directory", () => {
    const result = reviewDiff({
      diff: "x",
      changedFiles: ["packages/app/package-lock.json"],
    });
    expect(result.blocking.some((f) => f.check === "forbidden-file")).toBe(
      true,
    );
  });

  it("honors operator extraForbiddenPatterns", () => {
    const result = reviewDiff(
      { diff: "x", changedFiles: ["src/secrets/prod.yaml"] },
      { extraForbiddenPatterns: ["secrets/"] },
    );
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "forbidden-file")).toBe(
      true,
    );
  });

  it("rejects an invalid operator forbidden-path pattern", () => {
    expect(() =>
      reviewDiff(
        { diff: "x", changedFiles: ["src/app.ts"] },
        { extraForbiddenPatterns: ["["] },
      ),
    ).toThrow("Invalid coding diff-gate forbidden-path pattern");
  });

  it("does NOT flag a normal .ts file that merely contains 'config' in the name", () => {
    const result = reviewDiff({
      diff: addedFileDiff("src/app-config-loader.ts", ["export const x = 1;"]),
      changedFiles: ["src/app-config-loader.ts"],
    });
    expect(result.passed).toBe(true);
  });
});

describe("reviewDiff — oversize warns (does not block)", () => {
  it("warns when the changed-line count exceeds the threshold", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const diff = addedFileDiff("src/big.ts", lines);
    const result = reviewDiff(
      { diff, changedFiles: ["src/big.ts"] },
      { oversizeLineThreshold: 10 },
    );
    expect(result.passed).toBe(true); // WARN never blocks
    expect(result.warnings.some((f) => f.check === "oversize")).toBe(true);
  });

  it("does not warn under threshold", () => {
    const diff = addedFileDiff("src/small.ts", ["a", "b"]);
    const result = reviewDiff(
      { diff, changedFiles: ["src/small.ts"] },
      { oversizeLineThreshold: 10 },
    );
    expect(result.warnings).toHaveLength(0);
  });

  it("suppresses oversize warn when disabled", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const diff = addedFileDiff("src/big.ts", lines);
    const result = reviewDiff(
      { diff, changedFiles: ["src/big.ts"] },
      { oversizeLineThreshold: 10, disableOversizeWarn: true },
    );
    expect(result.warnings).toHaveLength(0);
  });
});

describe("reviewDiff — empty diff rejects", () => {
  it("blocks when diff is empty and no files changed", () => {
    const result = reviewDiff({ diff: "", changedFiles: [] });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "empty-diff")).toBe(true);
  });

  it("blocks on whitespace-only diff with no files", () => {
    const result = reviewDiff({ diff: "   \n\n  ", changedFiles: [] });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "empty-diff")).toBe(true);
  });

  it("does NOT flag empty-diff when files are listed (rename/mode-only change)", () => {
    // A pure rename can produce an empty textual diff but real changed files;
    // that is a legitimate PR, not an empty one.
    const result = reviewDiff({ diff: "", changedFiles: ["src/moved.ts"] });
    expect(result.blocking.some((f) => f.check === "empty-diff")).toBe(false);
  });
});

describe("reviewDiff — case-insensitive secret matching (parity with core)", () => {
  it("blocks a LOWERCASE env-style credential (core compiles patterns with `i`)", () => {
    const diff = addedFileDiff("config.sh", [
      "database_password=hunter2hunter2hunter2",
    ]);
    const result = reviewDiff({ diff, changedFiles: ["config.sh"] });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "secret")).toBe(true);
  });

  it("blocks a lowercase `authorization: bearer …` header", () => {
    const diff = addedFileDiff("req.ts", [
      'const h = "authorization: bearer abcdefghijklmnopqrstuvwxyz012345";',
    ]);
    const result = reviewDiff({ diff, changedFiles: ["req.ts"] });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "secret")).toBe(true);
  });
});

describe("reviewDiff — truncated diff fails closed", () => {
  it("blocks when the captured diff was truncated (partial secret scan)", () => {
    const diff = addedFileDiff("src/big.ts", ["export const x = 1;"]);
    const result = reviewDiff({
      diff,
      changedFiles: ["src/big.ts"],
      diffTruncated: true,
    });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "truncated-diff")).toBe(
      true,
    );
  });

  it("blocks when the changed-file list was truncated", () => {
    const result = reviewDiff({
      diff: addedFileDiff("src/ok.ts", ["export const ok = true;"]),
      changedFiles: ["src/ok.ts"],
      changedFilesTruncated: true,
    });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "truncated-files")).toBe(
      true,
    );
  });

  it("still reports an early secret AND the truncation block together", () => {
    const diff = addedFileDiff("src/a.ts", [`const k = "${openAiTestKey()}";`]);
    const result = reviewDiff({
      diff,
      changedFiles: ["src/a.ts"],
      diffTruncated: true,
    });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "secret")).toBe(true);
    expect(result.blocking.some((f) => f.check === "truncated-diff")).toBe(
      true,
    );
  });

  it("does not block on truncation when diffTruncated is false", () => {
    const diff = addedFileDiff("src/ok.ts", ["export const y = 2;"]);
    const result = reviewDiff({
      diff,
      changedFiles: ["src/ok.ts"],
      diffTruncated: false,
    });
    expect(result.passed).toBe(true);
  });
});

describe("reviewDiff — combined + summary", () => {
  it("collects a block and a warn together, verdict is blocked", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const diff = `${addedFileDiff("src/big.ts", lines)}\n${addedFileDiff(
      "bun.lock",
      ['"x": "1"'],
    )}`;
    const result: DiffGateResult = reviewDiff(
      { diff, changedFiles: ["src/big.ts", "bun.lock"] },
      { oversizeLineThreshold: 10 },
    );
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "forbidden-file")).toBe(
      true,
    );
    expect(result.warnings.some((f) => f.check === "oversize")).toBe(true);
    const summary = summarizeDiffGate(result);
    expect(summary).toContain("BLOCKED");
    expect(summary).toContain("forbidden-file");
    expect(summary).toContain("oversize");
  });

  it("scannedLines counts added and removed hunk lines only", () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " context",
    ].join("\n");
    const result = reviewDiff({ diff, changedFiles: ["x"] });
    expect(result.scannedLines).toBe(2);
  });
});
