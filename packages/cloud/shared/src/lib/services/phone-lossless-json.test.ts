import { describe, expect, test } from "bun:test";
import {
  isPhoneLosslessJsonNumber,
  parsePhoneJsonLosslessly,
  parsePhoneLosslessJsonObject,
} from "./phone-lossless-json";
import { requirePhoneJsonObject, validatePhoneMessageMetadata } from "./phone-payload-validation";

describe("phone lossless JSON hydration", () => {
  test("keeps ordinary exact numbers ergonomic and preserves lossy numbers as raw JSON", () => {
    const value = parsePhoneJsonLosslessly(
      '{"ordinary":3.5,"huge":1e400,"tiny":1e-400,"rounded":9007199254740993}',
    ) as Record<string, unknown>;

    expect(value.ordinary).toBe(3.5);
    expect(isPhoneLosslessJsonNumber(value.huge)).toBe(true);
    expect(isPhoneLosslessJsonNumber(value.tiny)).toBe(true);
    expect(isPhoneLosslessJsonNumber(value.rounded)).toBe(true);
    expect(JSON.stringify(value)).toBe(
      '{"ordinary":3.5,"huge":1e400,"tiny":1e-400,"rounded":9007199254740993}',
    );
  });

  test("accepts raw number leaves but never mistakes a lookalike or top-level number for metadata", () => {
    const value = parsePhoneLosslessJsonObject('{"nested":{"huge":1e400},"values":[1e-400]}');
    expect(requirePhoneJsonObject(value)).toBe(value);
    const shallow = parsePhoneJsonLosslessly('{"huge":1e400}');
    expect(validatePhoneMessageMetadata(shallow)).toBe(shallow);

    expect(() => requirePhoneJsonObject({ huge: { rawJSON: "1e400" } })).not.toThrow();
    expect(() => requirePhoneJsonObject(parsePhoneJsonLosslessly("1e400"))).toThrow();
    expect(() => parsePhoneLosslessJsonObject("1e400")).toThrow(
      "Persisted phone metadata is not a JSON object",
    );
    expect(() => parsePhoneLosslessJsonObject("[]")).toThrow(
      "Persisted phone metadata is not a JSON object",
    );
  });
});
