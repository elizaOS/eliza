/**
 * Prefix-coerced conversion pixel value must be invalid.
 * Number("1e2") === 100 used to become a real tracked amount.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { AGGRESSIVE: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/advertising", () => ({
  advertisingService: { recordConversion: async () => ({}) },
}));

mock.module("@/lib/services/advertising/schemas", () => ({
  RecordConversionSchema: { safeParse: () => ({ success: false }) },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { warn: () => undefined },
}));

const { parseConversionQueryValue } = await import("./route");

describe("advertising conversion query value", () => {
  test("1e2 is invalid instead of becoming 100", () => {
    expect(parseConversionQueryValue("1e2")).toBe("invalid");
  });

  test("007 is invalid instead of becoming 7", () => {
    expect(parseConversionQueryValue("007")).toBe("invalid");
  });

  test("0x10 is invalid instead of becoming 16", () => {
    expect(parseConversionQueryValue("0x10")).toBe("invalid");
  });

  test("canonical 3 still parses", () => {
    expect(parseConversionQueryValue("3")).toBe(3);
  });

  test("canonical 10.5 still parses", () => {
    expect(parseConversionQueryValue("10.5")).toBe(10.5);
  });

  test("omitted value stays undefined", () => {
    expect(parseConversionQueryValue(undefined)).toBeUndefined();
  });
});
