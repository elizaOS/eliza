import { describe, expect, it } from "vitest";
import { formatTimezoneOffsetToken } from "./types.js";

describe("formatTimezoneOffsetToken", () => {
  it("formats offset tokens including Unicode minus signs, UTC formats, and historical seconds offsets", () => {
    expect(formatTimezoneOffsetToken("GMT\u22127")).toBe("-07:00");
    expect(formatTimezoneOffsetToken("UTC-5")).toBe("-05:00");
    expect(formatTimezoneOffsetToken("-07:00")).toBe("-07:00");
    expect(formatTimezoneOffsetToken("GMT+02:00")).toBe("+02:00");
    expect(formatTimezoneOffsetToken("GMT-5")).toBe("-05:00");
    expect(formatTimezoneOffsetToken("GMT-00:44:30")).toBe("-00:45");
    expect(formatTimezoneOffsetToken("GMT+00:19:32")).toBe("+00:20");
    expect(formatTimezoneOffsetToken("GMT-09:59:36")).toBe("-10:00");
  });
});
