/**
 * Behavioral coverage for Twilio call lifecycle receipt normalization.
 *
 * Provider callbacks deliver statuses like "completed"/"in-progress" with
 * arbitrary casing; app-local statuses ("requesting", "submission-unknown")
 * never come from the provider. Terminal statuses drive webhook settlement,
 * so the set membership must stay exact.
 */
import { describe, expect, test } from "bun:test";
import {
  isTerminalTwilioCallStatus,
  normalizeTwilioProviderCallStatus,
  parseTwilioSequenceNumber,
  TWILIO_CALL_STATUSES,
} from "./twilio-call-status";

describe("normalizeTwilioProviderCallStatus", () => {
  test("normalizes provider statuses with trim and lowercasing", () => {
    expect(normalizeTwilioProviderCallStatus("Completed")).toBe("completed");
    expect(normalizeTwilioProviderCallStatus(" in-progress ")).toBe("in-progress");
    expect(normalizeTwilioProviderCallStatus("queued")).toBe("queued");
    expect(normalizeTwilioProviderCallStatus("NO-ANSWER")).toBe("no-answer");
  });

  test("accepts every provider-sent status", () => {
    for (const status of [
      "queued",
      "initiated",
      "ringing",
      "in-progress",
      "completed",
      "busy",
      "failed",
      "no-answer",
      "canceled",
    ]) {
      expect(normalizeTwilioProviderCallStatus(status)).toBe(status);
    }
  });

  test("rejects app-local statuses the provider never sends", () => {
    expect(normalizeTwilioProviderCallStatus("requesting")).toBeNull();
    expect(normalizeTwilioProviderCallStatus("submission-unknown")).toBeNull();
    expect(normalizeTwilioProviderCallStatus("hangup-requested")).toBeNull();
  });

  test("rejects unknown or blank values", () => {
    expect(normalizeTwilioProviderCallStatus("not-a-status")).toBeNull();
    expect(normalizeTwilioProviderCallStatus("")).toBeNull();
    expect(normalizeTwilioProviderCallStatus("   ")).toBeNull();
  });
});

describe("isTerminalTwilioCallStatus", () => {
  test("treats completion and failure outcomes as terminal", () => {
    for (const status of [
      "completed",
      "busy",
      "failed",
      "no-answer",
      "canceled",
      "provider-error",
    ]) {
      expect(isTerminalTwilioCallStatus(status)).toBe(true);
    }
  });

  test("treats in-flight statuses as non-terminal", () => {
    for (const status of [
      "requesting",
      "queued",
      "initiated",
      "ringing",
      "in-progress",
      "hangup-requested",
      "submission-unknown",
    ]) {
      expect(isTerminalTwilioCallStatus(status)).toBe(false);
    }
  });

  test("is case-sensitive like the callbacks that emit it", () => {
    expect(isTerminalTwilioCallStatus("Completed")).toBe(false);
  });
});

describe("parseTwilioSequenceNumber", () => {
  test("parses plain digit strings", () => {
    expect(parseTwilioSequenceNumber("42")).toBe(42);
    expect(parseTwilioSequenceNumber("0")).toBe(0);
    expect(parseTwilioSequenceNumber("9007199254740991")).toBe(9007199254740991);
  });

  test("rejects undefined, empty, and malformed input", () => {
    expect(parseTwilioSequenceNumber(undefined)).toBeNull();
    expect(parseTwilioSequenceNumber("")).toBeNull();
    expect(parseTwilioSequenceNumber("12a")).toBeNull();
    expect(parseTwilioSequenceNumber("12.5")).toBeNull();
    expect(parseTwilioSequenceNumber("-3")).toBeNull();
    expect(parseTwilioSequenceNumber("1 2")).toBeNull();
  });

  test("rejects values outside the safe-integer range", () => {
    expect(parseTwilioSequenceNumber("9007199254740992")).toBeNull();
    expect(parseTwilioSequenceNumber("99999999999999999999")).toBeNull();
  });
});

describe("TWILIO_CALL_STATUSES", () => {
  test("lists every provider-sent status", () => {
    for (const status of [
      "queued",
      "initiated",
      "ringing",
      "in-progress",
      "completed",
      "busy",
      "failed",
      "no-answer",
      "canceled",
    ]) {
      expect(TWILIO_CALL_STATUSES).toContain(status);
    }
  });
});
