import { describe, expect, it } from "vitest";
import { __internal } from "./index.js";

const { parseEventLine } = __internal;

describe("parseEventLine", () => {
  it("parses a complete activate line with window title", () => {
    const line =
      '{"ts":1714000000000,"event":"activate","bundleId":"com.apple.Safari","appName":"Safari","windowTitle":"Google"}';
    expect(parseEventLine(line)).toEqual({
      ts: 1714000000000,
      event: "activate",
      bundleId: "com.apple.Safari",
      appName: "Safari",
      windowTitle: "Google",
    });
  });

  it("parses deactivate without window title", () => {
    const line =
      '{"ts":1714000001000,"event":"deactivate","bundleId":"com.apple.Safari","appName":"Safari"}';
    const parsed = parseEventLine(line);
    expect(parsed).toEqual({
      ts: 1714000001000,
      event: "deactivate",
      bundleId: "com.apple.Safari",
      appName: "Safari",
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseEventLine("{not json")).toBeNull();
  });

  it("returns null when event kind is unknown", () => {
    const line =
      '{"ts":1,"event":"hover","bundleId":"x","appName":"x"}';
    expect(parseEventLine(line)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const line = '{"ts":1,"event":"activate","bundleId":"x"}';
    expect(parseEventLine(line)).toBeNull();
  });

  it("ignores blank lines", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   ")).toBeNull();
  });
});
