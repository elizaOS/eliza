import { describe, expect, it, vi } from "vitest";
import {
  buildIndependentVerifierPrompt,
  runIndependentVerification,
  shouldRunIndependentVerify,
  verifierVerdict,
} from "../../src/services/independent-verifier.js";

function envelope(over: Record<string, unknown> = {}): string {
  return `\`\`\`json\n${JSON.stringify({
    diffSummary: "x",
    filesChanged: ["src/a.ts"],
    testResults: [{ command: "bun test", exitCode: 0, summary: "12 passed" }],
    screenshotPaths: [],
    acceptanceCriteriaStatus: [
      { criterion: "tests pass", met: true, evidence: "exit 0" },
    ],
    residualRisks: [],
    ...over,
  })}\n\`\`\``;
}

describe("buildIndependentVerifierPrompt (#8898)", () => {
  it("demands execution-based, read-only verification + an envelope", () => {
    const p = buildIndependentVerifierPrompt({
      goal: "add a button",
      acceptanceCriteria: ["tests pass", "button renders"],
    });
    expect(p).toContain("INDEPENDENT verifier");
    expect(p).toContain("Do NOT trust its narration");
    expect(p).toMatch(/Do NOT edit/i);
    expect(p).toContain("1. tests pass");
    expect(p).toContain("CompletionEnvelope");
  });
});

describe("verifierVerdict (#8898)", () => {
  it("passes only when all criteria met and all commands green", () => {
    const v = verifierVerdict(envelope());
    expect(v.passed).toBe(true);
    expect(v.inconclusive).toBe(false);
  });

  it("fails on an unmet criterion", () => {
    const v = verifierVerdict(
      envelope({
        acceptanceCriteriaStatus: [
          { criterion: "tests pass", met: false, evidence: "1 failing" },
        ],
      }),
    );
    expect(v.passed).toBe(false);
    expect(v.unmet).toEqual(["tests pass"]);
  });

  it("fails on a non-zero test exit code", () => {
    const v = verifierVerdict(
      envelope({
        testResults: [
          { command: "bun test", exitCode: 1, summary: "1 failed" },
        ],
      }),
    );
    expect(v.passed).toBe(false);
    expect(v.failedCommands).toEqual(["bun test"]);
  });

  it("is inconclusive (not a pass) when no envelope comes back", () => {
    const v = verifierVerdict("I checked, looks good!");
    expect(v.passed).toBe(false);
    expect(v.inconclusive).toBe(true);
  });

  it("is inconclusive when the envelope reports no criteria", () => {
    const v = verifierVerdict(envelope({ acceptanceCriteriaStatus: [] }));
    expect(v.passed).toBe(false);
    expect(v.inconclusive).toBe(true);
  });
});

describe("shouldRunIndependentVerify (#8898)", () => {
  it("defaults on for code-change tasks, off otherwise", () => {
    expect(shouldRunIndependentVerify(() => undefined, true)).toBe(true);
    expect(shouldRunIndependentVerify(() => undefined, false)).toBe(false);
  });
  it("honors explicit on/off overrides", () => {
    expect(shouldRunIndependentVerify(() => "0", true)).toBe(false);
    expect(shouldRunIndependentVerify(() => "always", false)).toBe(true);
  });
});

describe("runIndependentVerification (#8898)", () => {
  it("spawns with the verifier prompt and returns the verdict", async () => {
    const spawnAndAwait = vi.fn(async () => envelope());
    const v = await runIndependentVerification(
      { goal: "g", acceptanceCriteria: ["tests pass"] },
      { spawnAndAwait },
    );
    expect(v.passed).toBe(true);
    expect(spawnAndAwait).toHaveBeenCalledTimes(1);
    expect(spawnAndAwait.mock.calls[0][0]).toContain("INDEPENDENT verifier");
  });

  it("is inconclusive (never a false pass) when the spawn fails", async () => {
    const v = await runIndependentVerification(
      { goal: "g", acceptanceCriteria: ["tests pass"] },
      {
        spawnAndAwait: async () => {
          throw new Error("acp spawn failed");
        },
      },
    );
    expect(v.passed).toBe(false);
    expect(v.inconclusive).toBe(true);
    expect(v.summary).toContain("failed to run");
  });
});
