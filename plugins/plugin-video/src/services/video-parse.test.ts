import { describe, expect, it } from "vitest";
import {
  normalizeCaptionNewlines,
  parseYtDlpUploadDate,
} from "./video-parse";

describe("parseYtDlpUploadDate", () => {
  it("parses valid compact YYYYMMDD as UTC midnight", () => {
    expect(parseYtDlpUploadDate("20240531")?.toISOString()).toBe(
      "2024-05-31T00:00:00.000Z",
    );
  });

  it("accepts leap-day compact dates", () => {
    expect(parseYtDlpUploadDate("20240229")?.toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("rejects calendar-invalid compact dates that Date.UTC would overflow", () => {
    expect(parseYtDlpUploadDate("20240231")).toBeUndefined();
    expect(parseYtDlpUploadDate("20230229")).toBeUndefined();
    expect(parseYtDlpUploadDate("20240431")).toBeUndefined();
    expect(parseYtDlpUploadDate("20249999")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(parseYtDlpUploadDate(undefined)).toBeUndefined();
    expect(parseYtDlpUploadDate("")).toBeUndefined();
  });
});

describe("normalizeCaptionNewlines", () => {
  it("replaces LF globally with spaces", () => {
    expect(normalizeCaptionNewlines("First line\nsecond line\nThird line\n")).toBe(
      "First line second line Third line ",
    );
  });

  it("normalizes CRLF and bare CR without leaking \\r", () => {
    const out = normalizeCaptionNewlines("first\r\nsecond\rthird\nfourth");
    expect(out).toBe("first second third fourth");
    expect(out).not.toContain("\r");
  });
});
