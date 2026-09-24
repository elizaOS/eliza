/**
 * Exercises fail-closed input validation for cloud meeting billing.
 *
 * Deterministic unit coverage verifies three security-sensitive boundaries:
 *
 *  1. `MeetingCreditBillingSession` accepted a NaN `maxDurationMs`, which
 *     disables the spend cap (`nextConsumedMs > NaN` is false), and NaN or
 *     negative rate/window options that flow into reservation amounts. The
 *     constructor must now reject non-finite / non-positive money inputs.
 *  2. `resolveMeetingUsdPerMinute` silently fell back to the default rate when
 *     ELIZA_MEETINGS_TRANSCRIPTION_USD_PER_MINUTE was present but invalid, so
 *     a typo'd price billed every meeting at the wrong rate. Present-but-
 *     invalid must now throw; unset/blank still uses the default.
 *  3. `creditsService.reserve()` refuses non-finite amounts before database
 *     access. The authoritative mutation has separate real-PGlite coverage.
 */

import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { ElizaError } from "@elizaos/core";
import { creditsService } from "../credits";
import { createMeetingCreditBillingSession, resolveMeetingUsdPerMinute } from "../meeting-billing";

const BASE_OPTIONS = {
  organizationId: "00000000-0000-0000-0000-000000001627",
  sessionId: "meeting-session-1",
  maxDurationMs: 3_600_000,
};

function expectInvalidOption(fn: () => unknown, option: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ElizaError);
  const err = caught as ElizaError;
  expect(err.code).toBe("INVALID_MEETING_BILLING_OPTION");
  expect(err.context?.option).toBe(option);
  expect(err.context?.sessionId).toBe(BASE_OPTIONS.sessionId);
}

describe("MeetingCreditBillingSession constructor validation", () => {
  test("rejects NaN maxDurationMs (would disable the spend cap)", () => {
    expectInvalidOption(
      () => createMeetingCreditBillingSession({ ...BASE_OPTIONS, maxDurationMs: Number.NaN }),
      "maxDurationMs",
    );
  });

  test("rejects zero and negative maxDurationMs", () => {
    for (const maxDurationMs of [0, -1]) {
      expectInvalidOption(
        () => createMeetingCreditBillingSession({ ...BASE_OPTIONS, maxDurationMs }),
        "maxDurationMs",
      );
    }
  });

  test("rejects non-finite and non-positive rate/window options", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -0.01]) {
      expectInvalidOption(
        () => createMeetingCreditBillingSession({ ...BASE_OPTIONS, usdPerMinute: bad }),
        "usdPerMinute",
      );
      expectInvalidOption(
        () => createMeetingCreditBillingSession({ ...BASE_OPTIONS, initialWindowMs: bad }),
        "initialWindowMs",
      );
      expectInvalidOption(
        () => createMeetingCreditBillingSession({ ...BASE_OPTIONS, chunkWindowMs: bad }),
        "chunkWindowMs",
      );
    }
  });

  test("accepts valid options (guard is not over-broad)", () => {
    const session = createMeetingCreditBillingSession({
      ...BASE_OPTIONS,
      usdPerMinute: 0.006,
      initialWindowMs: 60_000,
      chunkWindowMs: 60_000,
    });
    expect(session.state.status).toBe("reserved");
    expect(session.state.capMs).toBe(BASE_OPTIONS.maxDurationMs);
  });
});

describe("resolveMeetingUsdPerMinute env parsing", () => {
  test("unset or blank uses the default", () => {
    expect(resolveMeetingUsdPerMinute({})).toBeCloseTo(0.006, 9);
    expect(
      resolveMeetingUsdPerMinute({ ELIZA_MEETINGS_TRANSCRIPTION_USD_PER_MINUTE: "  " }),
    ).toBeCloseTo(0.006, 9);
  });

  test("a valid override is used", () => {
    expect(
      resolveMeetingUsdPerMinute({ ELIZA_MEETINGS_TRANSCRIPTION_USD_PER_MINUTE: "0.01" }),
    ).toBeCloseTo(0.01, 9);
  });

  test("present-but-invalid values throw instead of billing at the default rate", () => {
    for (const bad of ["0..01", "abc", "-1", "0", "NaN", "Infinity"]) {
      let caught: unknown;
      try {
        resolveMeetingUsdPerMinute({ ELIZA_MEETINGS_TRANSCRIPTION_USD_PER_MINUTE: bad });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ElizaError);
      const err = caught as ElizaError;
      expect(err.code).toBe("INVALID_MEETING_USD_PER_MINUTE");
      expect(err.context?.configured).toBe(bad);
    }
  });
});

describe("creditsService.reserve amount validation", () => {
  test("refuses NaN and Infinity amounts before any DB access", async () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        creditsService.reserve({
          organizationId: BASE_OPTIONS.organizationId,
          amount,
          description: "meeting billing guard test",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_CREDIT_AMOUNT",
        context: { amount, operation: "reserve", permitsZero: true },
      });
    }
  });

  test("still refuses negative amounts", async () => {
    await expect(
      creditsService.reserve({
        organizationId: BASE_OPTIONS.organizationId,
        amount: -1,
        description: "meeting billing guard test",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CREDIT_AMOUNT",
      context: { amount: -1, operation: "reserve", permitsZero: true },
    });
  });
});
