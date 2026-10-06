import { describe, expect, test } from "bun:test";
import {
  calculateTwilioSmsBilling,
  classifyTwilioSmsCostConfig,
  DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
  resolveTwilioSmsCostPerSegment,
} from "./markup.js";

describe("Twilio billing configuration", () => {
  test("missing values retain the default without being classified as invalid", () => {
    for (const value of [undefined, null, "", "  "]) {
      expect(classifyTwilioSmsCostConfig(value)).toEqual({ status: "absent" });
      expect(resolveTwilioSmsCostPerSegment(value)).toBe(
        DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
      );
    }
  });
  test("accepts complete finite nonnegative decimal values including zero", () => {
    for (const [value, expected] of [
      [0, 0],
      ["+0.01", 0.01],
      [".5", 0.5],
      [" 1e-2 ", 0.01],
      ["2.", 2],
    ] as const) {
      expect(classifyTwilioSmsCostConfig(value)).toEqual({
        status: "valid",
        value: expected,
      });
      expect(resolveTwilioSmsCostPerSegment(value)).toBe(expected);
    }
  });
  test("rejects malformed supplied values so the gateway can warn and use a fallback", () => {
    for (const value of [
      "0x10",
      "0b1",
      "0o7",
      "1.2.3",
      "0.01USD",
      "Infinity",
      "-1",
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(classifyTwilioSmsCostConfig(value)).toEqual({ status: "invalid" });
      expect(resolveTwilioSmsCostPerSegment(value, 0.02)).toBe(0.02);
    }
    expect(() => resolveTwilioSmsCostPerSegment("0.01", -1)).toThrow(
      RangeError,
    );
  });
  test("preserves message segmentation and rounded markup", () => {
    expect(calculateTwilioSmsBilling("", 0.0075)).toEqual({
      segments: 1,
      costPerSegment: 0.0075,
      rawCost: 0.01,
      markup: 0,
      billedCost: 0.01,
      markupRate: 0.2,
    });
    expect(calculateTwilioSmsBilling("x".repeat(161), 0.05)).toEqual({
      segments: 2,
      costPerSegment: 0.05,
      rawCost: 0.1,
      markup: 0.02,
      billedCost: 0.12,
      markupRate: 0.2,
    });
    expect(() => calculateTwilioSmsBilling("x", -1)).toThrow(RangeError);
  });
});
