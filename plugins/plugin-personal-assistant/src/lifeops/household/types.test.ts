import { describe, expect, it } from "vitest";
import { formatTimezoneOffsetToken } from "./types.js";

describe("formatTimezoneOffsetToken", () => {
  it("formats offset tokens including Unicode minus signs and UTC formats", () => {
    expect(formatTimezoneOffsetToken("GMT\u22127")).toBe("-07:00");
    expect(formatTimezoneOffsetToken("UTC-5")).toBe("-05:00");
    expect(formatTimezoneOffsetToken("-07:00")).toBe("-07:00");
    expect(formatTimezoneOffsetToken("GMT+02:00")).toBe("+02:00");
    expect(formatTimezoneOffsetToken("GMT-5")).toBe("-05:00");
  });
});
