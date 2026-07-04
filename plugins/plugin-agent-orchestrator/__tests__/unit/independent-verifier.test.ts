/**
 * Verifies verdictFromEnvelope.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  shouldRunIndependentVerify,
  verdictFromEnvelope,
} from "../../src/services/independent-verifier.js";

// #9146 — the independent verifier is the quality gate over a spawned coding
// agent's self-reported completion. Pin the verdict logic + the enable gate.
const env = (o: Record<string, unknown>) =>
  o as unknown as Parameters<typeof verdictFromEnvelope>[0];

describe("verdictFromEnvelope", () => {
  it("passes only when every criterion is met and every command is green", () => {
    const v = verdictFromEnvelope(
      env({
        acceptanceCriteriaStatus: [{ criterion: "builds", met: true }],
        testResults: [{ command: "bun run build", exitCode: 0 }],
      }),
    );
    expect(v).toMatchObject({
      passed: true,
      inconclusive: false,
      unmet: [],
      failedCommands: [],
    });
  });

  it("fails and lists the unmet criteria + failing commands", () => {
    const v = verdictFromEnvelope(
      env({
        acceptanceCriteriaStatus: [
          { criterion: "builds", met: true },
          { criterion: "tests pass", met: false },
        ],
        testResults: [{ command: "bun test", exitCode: 1 }],
      }),
    );
    expect(v.passed).toBe(false);
    expect(v.unmet).toEqual(["tests pass"]);
    expect(v.failedCommands).toEqual(["bun test"]);
  });

  it("is inconclusive (not passed) when no per-criterion status is reported", () => {
    const v = verdictFromEnvelope(
      env({ acceptanceCriteriaStatus: [], testResults: [] }),
    );
    expect(v).toMatchObject({ inconclusive: true, passed: false });
    expect(v.summary).toContain("unverified");
  });
});

describe("shouldRunIndependentVerify", () => {
  const get = (val: string | undefined) => () => val;
  it("honors explicit on/off settings over the code-change default", () => {
    expect(shouldRunIndependentVerify(get("0"), true)).toBe(false);
    expect(shouldRunIndependentVerify(get("false"), true)).toBe(false);
    expect(shouldRunIndependentVerify(get("1"), false)).toBe(true);
    expect(shouldRunIndependentVerify(get("always"), false)).toBe(true);
  });

  it("defaults to on only for code-change tasks", () => {
    expect(shouldRunIndependentVerify(get(undefined), true)).toBe(true);
    expect(shouldRunIndependentVerify(get(undefined), false)).toBe(false);
  });
});
