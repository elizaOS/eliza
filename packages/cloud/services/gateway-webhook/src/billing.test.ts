/**
 * Verifies the gateway-webhook Twilio SMS cost resolver enforces strict
 * full-string parsing so partially-numeric configuration falls back to the
 * safe default, matching the canonical `@elizaos/cloud-shared` resolver rather
 * than silently truncating with `Number.parseFloat`.
 */
import { describe, expect, test } from "bun:test";
import { resolveTwilioSmsCostPerSegment as sharedResolve } from "@elizaos/cloud-shared/billing";
import {
  classifyTwilioSmsCostConfig,
  DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
  resolveTwilioSmsCostPerSegment,
} from "./billing";

describe("resolveTwilioSmsCostPerSegment strict parsing", () => {
  test("resolves valid numeric strings and whitespace-padded values", () => {
    expect(resolveTwilioSmsCostPerSegment("0.0075")).toBe(0.0075);
    expect(resolveTwilioSmsCostPerSegment("0.01")).toBe(0.01);
    expect(resolveTwilioSmsCostPerSegment(" 0.01 ")).toBe(0.01);
    expect(resolveTwilioSmsCostPerSegment(0)).toBe(0);
    expect(resolveTwilioSmsCostPerSegment(0.02)).toBe(0.02);
  });

  test("falls back to the default when configuration is absent", () => {
    expect(resolveTwilioSmsCostPerSegment(undefined)).toBe(
      DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
    );
    expect(resolveTwilioSmsCostPerSegment(null)).toBe(
      DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
    );
    expect(resolveTwilioSmsCostPerSegment("")).toBe(
      DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
    );
  });

  test("rejects malformed prefix, multi-dot, non-finite and negative values", () => {
    for (const raw of [
      "0.01USD",
      "1.2.3",
      "abc",
      "NaN",
      "Infinity",
      "-1",
      "-0.01",
    ]) {
      expect(resolveTwilioSmsCostPerSegment(raw)).toBe(
        DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
      );
    }
  });

  test("matches the canonical shared resolver for the same inputs (parity)", () => {
    for (const raw of [
      "0.0075",
      "0.01",
      " 0.01 ",
      "",
      "0.01USD",
      "1.2.3",
      "abc",
      "-1",
    ]) {
      expect(resolveTwilioSmsCostPerSegment(raw)).toBe(sharedResolve(raw));
    }
    expect(resolveTwilioSmsCostPerSegment("0.01USD")).toBe(
      sharedResolve("0.01USD"),
    );
  });
});

describe("classifyTwilioSmsCostConfig", () => {
  test("distinguishes absent, invalid, and valid configuration", () => {
    expect(classifyTwilioSmsCostConfig(undefined)).toEqual({
      status: "absent",
    });
    expect(classifyTwilioSmsCostConfig(null)).toEqual({ status: "absent" });
    expect(classifyTwilioSmsCostConfig("")).toEqual({ status: "absent" });
    expect(classifyTwilioSmsCostConfig("0.01USD")).toEqual({
      status: "invalid",
    });
    expect(classifyTwilioSmsCostConfig("1.2.3")).toEqual({ status: "invalid" });
    expect(classifyTwilioSmsCostConfig("-1")).toEqual({ status: "invalid" });
    expect(classifyTwilioSmsCostConfig(" 0.01 ")).toEqual({
      status: "valid",
      value: 0.01,
    });
  });
});
