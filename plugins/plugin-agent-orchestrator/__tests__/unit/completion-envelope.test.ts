import { describe, expect, it } from "vitest";
import {
  COMPLETION_ENVELOPE_INSTRUCTION,
  type CompletionEnvelope,
  envelopeCorrection,
  parseCompletionEnvelope,
  summarizeEnvelope,
} from "../../src/services/completion-envelope.js";

function validEnvelope(): CompletionEnvelope {
  return {
    diffSummary: "added the thing",
    filesChanged: ["src/a.ts"],
    testResults: [{ command: "bun test", exitCode: 0, summary: "12 passed" }],
    screenshotPaths: [],
    acceptanceCriteriaStatus: [
      { criterion: "tests pass", met: true, evidence: "bun test exit 0" },
    ],
    residualRisks: [],
  };
}

function fenced(obj: unknown): string {
  return `Done!\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

describe("parseCompletionEnvelope (#8895)", () => {
  it("returns present:false when there is no envelope (heuristic fallback)", () => {
    expect(parseCompletionEnvelope("I finished the task.")).toEqual({
      present: false,
    });
  });

  it("parses a valid fenced envelope", () => {
    const res = parseCompletionEnvelope(fenced(validEnvelope()));
    expect(res.present).toBe(true);
    expect(res.ok).toBe(true);
    if (res.present && res.ok) {
      expect(res.envelope.diffSummary).toBe("added the thing");
      expect(res.envelope.testResults[0].exitCode).toBe(0);
      expect(res.envelope.acceptanceCriteriaStatus[0].met).toBe(true);
    }
  });

  it("carries the real workdir and disk-verified changed files", () => {
    const res = parseCompletionEnvelope(
      fenced({
        ...validEnvelope(),
        realWorkdir: "/workspace/task-real",
        verifiedChangedFiles: [
          {
            path: "src/a.ts",
            exists: true,
            absolutePath: "/workspace/task-real/src/a.ts",
            sizeBytes: 12,
          },
        ],
        artifactsVerified: true,
        missingArtifacts: [],
      }),
    );
    expect(res.present).toBe(true);
    expect(res.ok).toBe(true);
    if (res.present && res.ok) {
      expect(res.envelope.realWorkdir).toBe("/workspace/task-real");
      expect(res.envelope.verifiedChangedFiles?.[0]).toMatchObject({
        path: "src/a.ts",
        exists: true,
      });
      expect(res.envelope.artifactsVerified).toBe(true);
    }
  });

  it("marks missing artifacts as unverified", () => {
    const res = parseCompletionEnvelope(
      fenced({
        ...validEnvelope(),
        realWorkdir: "/workspace/task-real",
        verifiedChangedFiles: [{ path: "index.html", exists: false }],
        artifactsVerified: false,
        missingArtifacts: ["index.html"],
      }),
    );
    expect(res.present).toBe(true);
    expect(res.ok).toBe(true);
    if (res.present && res.ok) {
      expect(res.envelope.artifactsVerified).toBe(false);
      expect(res.envelope.missingArtifacts).toEqual(["index.html"]);
      expect(summarizeEnvelope(res.envelope)).toContain("UNVERIFIED missing");
    }
  });

  it("flags a present-but-incomplete envelope (missing testResults)", () => {
    const { testResults, ...partial } = validEnvelope();
    void testResults;
    const res = parseCompletionEnvelope(fenced(partial));
    expect(res).toMatchObject({ present: true, ok: false });
    if (res.present && !res.ok) {
      expect(res.errors.join(" ")).toContain("testResults");
    }
  });

  it("flags malformed test rows + bad criteria shapes", () => {
    const bad = {
      ...validEnvelope(),
      testResults: [{ command: "x" }],
      acceptanceCriteriaStatus: [{ criterion: "c" }],
    };
    const res = parseCompletionEnvelope(fenced(bad));
    expect(res).toMatchObject({ present: true, ok: false });
    if (res.present && !res.ok) {
      expect(res.errors.some((e) => e.includes("testResults[0]"))).toBe(true);
      expect(
        res.errors.some((e) => e.includes("acceptanceCriteriaStatus[0]")),
      ).toBe(true);
    }
  });

  it("treats a fenced-but-unparseable block as a broken attempt (not absent)", () => {
    const res = parseCompletionEnvelope("```json\n{not json}\n```");
    expect(res).toMatchObject({ present: true, ok: false });
  });

  it("reads the LAST fenced block when several are present", () => {
    const earlier = fenced({ diffSummary: "draft" });
    const final = fenced(validEnvelope());
    const res = parseCompletionEnvelope(`${earlier}\n\nthen\n\n${final}`);
    expect(res.ok).toBe(true);
  });

  it("accepts a bare JSON object with no fence", () => {
    const res = parseCompletionEnvelope(JSON.stringify(validEnvelope()));
    expect(res.ok).toBe(true);
  });
});

describe("summarizeEnvelope + envelopeCorrection (#8895)", () => {
  it("summarizes met/unmet criteria + test results", () => {
    const env = validEnvelope();
    env.acceptanceCriteriaStatus.push({
      criterion: "lint clean",
      met: false,
      evidence: "biome found 2 issues",
    });
    const s = summarizeEnvelope(env);
    expect(s).toContain("bun test → exit 0");
    expect(s).toContain("1/2 met");
    expect(s).toContain("unmet: lint clean");
  });

  it("builds a correction listing the parse errors", () => {
    const c = envelopeCorrection(["testResults must be an array"]);
    expect(c).toContain("did not include a valid CompletionEnvelope");
    expect(c).toContain("testResults must be an array");
  });

  it("the spawn instruction names every required key", () => {
    for (const key of [
      "diffSummary",
      "filesChanged",
      "testResults",
      "acceptanceCriteriaStatus",
      "residualRisks",
    ]) {
      expect(COMPLETION_ENVELOPE_INSTRUCTION).toContain(key);
    }
  });
});
