/**
 * Unit tests for the pure verdict logic and poll-policy parsers of the iOS
 * voice round-trip lane. Deterministic — no simulator, no device, no model;
 * exercises the no-false-green contract (skipped != pass, transcript + reply
 * presence) and fail-closed poll env validation that gates
 * `ios-voice-selftest-smoke.mjs`. Runs in the packages/app vitest suite
 * (root `test:client` lane).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_SELFTEST_ATTEMPTS,
  DEFAULT_VOICE_SELFTEST_DELAY_MS,
  evaluateVoiceSelfTestReport,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
  REQUIRED_VOICE_STAGES,
  resolveVoiceSelfTestPollPolicy,
} from "./ios-voice-selftest-lib.mjs";

const SMOKE_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "ios-voice-selftest-smoke.mjs",
);

function runSmokeCli(env = {}) {
  return spawnSync(process.execPath, [SMOKE_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      IOS_VOICE_SELFTEST_ATTEMPTS: undefined,
      IOS_VOICE_SELFTEST_DELAY_MS: undefined,
      ...env,
    },
    timeout: 15_000,
  });
}

function stage(name, status) {
  return { stage: name, status, durationMs: 1, detail: {} };
}

function passingReport(overrides = {}) {
  return {
    schemaVersion: 1,
    overall: "pass",
    platform: "ios",
    mode: "wav-direct",
    ttsRoute: "/api/tts/local-inference",
    expectedPhrase: "what time is it",
    transcript: "what time is it",
    reply: "It is 3 o'clock.",
    stages: [stage("asr", "pass"), stage("send", "pass"), stage("tts", "pass")],
    ...overrides,
  };
}

describe("evaluateVoiceSelfTestReport", () => {
  it("passes a fully green real round-trip", () => {
    const verdict = evaluateVoiceSelfTestReport(passingReport());
    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.stageStatuses).toEqual({
      asr: "pass",
      send: "pass",
      tts: "pass",
    });
    expect(verdict.transcript).toBe("what time is it");
    expect(verdict.reply).toBe("It is 3 o'clock.");
  });

  it("requires the three real pipeline stages", () => {
    expect(REQUIRED_VOICE_STAGES).toEqual(["asr", "send", "tts"]);
  });

  it("fails loudly when the ASR stage is skipped (not provisioned)", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "fail",
        stages: [
          stage("asr", "skipped"),
          stage("send", "skipped"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain(
      'stage "asr" is "skipped", expected "pass"',
    );
  });

  it("treats an all-skipped overall=skipped report as a failure", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "skipped",
        stages: [
          stage("asr", "skipped"),
          stage("send", "skipped"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('overall is "skipped", expected "pass"');
  });

  it("fails when the agent send stage fails", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        overall: "fail",
        reply: "",
        stages: [
          stage("asr", "pass"),
          stage("send", "fail"),
          stage("tts", "skipped"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain(
      'stage "send" is "fail", expected "pass"',
    );
    expect(verdict.reasons).toContain("agent reply is empty");
  });

  it("fails when the transcript does not contain the expected phrase word", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({ transcript: "banana bread please" }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("does not contain"))).toBe(
      true,
    );
  });

  it("fails when a required stage is entirely absent", () => {
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({ stages: [stage("asr", "pass"), stage("send", "pass")] }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('stage "tts" is missing from the report');
  });

  it("does not throw on a missing/garbage report", () => {
    expect(evaluateVoiceSelfTestReport(null).pass).toBe(false);
    expect(evaluateVoiceSelfTestReport(undefined).pass).toBe(false);
    expect(evaluateVoiceSelfTestReport("nope").pass).toBe(false);
    expect(evaluateVoiceSelfTestReport(42).pass).toBe(false);
  });

  it("fails when overall is pass but a stage silently regressed to fail", () => {
    // Defends against trusting `overall` alone — the stage grid is authoritative.
    const verdict = evaluateVoiceSelfTestReport(
      passingReport({
        stages: [
          stage("asr", "pass"),
          stage("send", "pass"),
          stage("tts", "fail"),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('stage "tts" is "fail", expected "pass"');
  });
});

describe("parsePositiveSafeInteger", () => {
  it("accepts positive safe integers as strings and numbers", () => {
    expect(parsePositiveSafeInteger("1", "label")).toBe(1);
    expect(parsePositiveSafeInteger("300", "label")).toBe(300);
    expect(parsePositiveSafeInteger(90, "label")).toBe(90);
    expect(parsePositiveSafeInteger(" 15 ", "label")).toBe(15);
  });

  it("rejects zero, negative, partial, signed, fractional, and non-decimal forms", () => {
    const bad = [
      "0",
      "-1",
      "1.5",
      "30junk",
      "+300",
      "0x10",
      "1e2",
      "0300",
      "",
      " ",
      "NaN",
      "Infinity",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -3,
      0,
      1.5,
    ];
    for (const value of bad) {
      expect(() => parsePositiveSafeInteger(value, "label")).toThrow(
        /must be a positive safe-integer decimal/,
      );
    }
  });
});

describe("parseNonNegativeSafeInteger", () => {
  it("accepts zero and positive safe integers", () => {
    expect(parseNonNegativeSafeInteger("0", "label")).toBe(0);
    expect(parseNonNegativeSafeInteger(0, "label")).toBe(0);
    expect(parseNonNegativeSafeInteger("1000", "label")).toBe(1000);
    expect(parseNonNegativeSafeInteger(" 10 ", "label")).toBe(10);
  });

  it("rejects negative, partial, signed, fractional, and non-decimal forms", () => {
    const bad = [
      "-1",
      "1.5",
      "10junk",
      "+1000",
      "0x10",
      "1e2",
      "01000",
      "",
      " ",
      "NaN",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -3,
      1.5,
    ];
    for (const value of bad) {
      expect(() => parseNonNegativeSafeInteger(value, "label")).toThrow(
        /must be a non-negative safe-integer decimal/,
      );
    }
  });
});

describe("resolveVoiceSelfTestPollPolicy", () => {
  it("uses defaults when unset or empty", () => {
    expect(resolveVoiceSelfTestPollPolicy({ env: {} })).toEqual({
      attempts: DEFAULT_VOICE_SELFTEST_ATTEMPTS,
      delayMs: DEFAULT_VOICE_SELFTEST_DELAY_MS,
    });
    expect(
      resolveVoiceSelfTestPollPolicy({
        env: {
          IOS_VOICE_SELFTEST_ATTEMPTS: "",
          IOS_VOICE_SELFTEST_DELAY_MS: "   ",
        },
      }),
    ).toEqual({
      attempts: DEFAULT_VOICE_SELFTEST_ATTEMPTS,
      delayMs: DEFAULT_VOICE_SELFTEST_DELAY_MS,
    });
  });

  it("accepts valid explicit overrides", () => {
    expect(
      resolveVoiceSelfTestPollPolicy({
        env: {
          IOS_VOICE_SELFTEST_ATTEMPTS: "45",
          IOS_VOICE_SELFTEST_DELAY_MS: "0",
        },
      }),
    ).toEqual({ attempts: 45, delayMs: 0 });
  });

  it("fails closed on explicit invalid attempts", () => {
    for (const value of ["0", "30junk", "notanumber", "1.5", "+300", "0300"]) {
      expect(() =>
        resolveVoiceSelfTestPollPolicy({
          env: { IOS_VOICE_SELFTEST_ATTEMPTS: value },
        }),
      ).toThrow(
        /IOS_VOICE_SELFTEST_ATTEMPTS must be a positive safe-integer decimal/,
      );
    }
  });

  it("fails closed on explicit invalid delay", () => {
    for (const value of ["-1", "10junk", "1.5", "+1000", "01000"]) {
      expect(() =>
        resolveVoiceSelfTestPollPolicy({
          env: { IOS_VOICE_SELFTEST_DELAY_MS: value },
        }),
      ).toThrow(
        /IOS_VOICE_SELFTEST_DELAY_MS must be a non-negative safe-integer decimal/,
      );
    }
  });
});

describe("ios-voice-selftest-smoke CLI boundary", () => {
  it("rejects invalid IOS_VOICE_SELFTEST_ATTEMPTS before simulator work", () => {
    for (const value of ["0", "30junk", "notanumber", "1.5", "+300"]) {
      const result = runSmokeCli({ IOS_VOICE_SELFTEST_ATTEMPTS: value });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(combined).toMatch(
        /IOS_VOICE_SELFTEST_ATTEMPTS must be a positive safe-integer decimal/,
      );
      expect(combined).not.toMatch(/\[ios-voice-selftest\]/);
      expect(combined).not.toMatch(/xcrun|simctl|simulator/i);
    }
  });

  it("rejects invalid IOS_VOICE_SELFTEST_DELAY_MS before simulator work", () => {
    for (const value of ["-1", "10junk", "1.5", "+1000"]) {
      const result = runSmokeCli({ IOS_VOICE_SELFTEST_DELAY_MS: value });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(combined).toMatch(
        /IOS_VOICE_SELFTEST_DELAY_MS must be a non-negative safe-integer decimal/,
      );
      expect(combined).not.toMatch(/\[ios-voice-selftest\]/);
      expect(combined).not.toMatch(/xcrun|simctl|simulator/i);
    }
  });
});
