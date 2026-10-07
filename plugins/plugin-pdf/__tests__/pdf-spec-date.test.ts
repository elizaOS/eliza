/**
 * Behavioral regression for PDF-spec `D:` dates: years 0-99 must stay literal
 * (`Date.UTC(10, …)` is 1910; `setUTCFullYear(10, …)` is year 10). Drives the
 * real `parsePdfSpecDate` export, including the no-timezone local branch.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(),
}));

import { parsePdfSpecDate } from "../services/pdf-date";

describe("parsePdfSpecDate years 0-99", () => {
  it("UTC year 10 stays 10, not 1910", () => {
    const parsed = parsePdfSpecDate("D:00100101120000Z");
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed?.getUTCFullYear()).toBe(10);
    expect(parsed?.getUTCMonth()).toBe(0);
    expect(parsed?.getUTCDate()).toBe(1);
    expect(parsed?.getUTCHours()).toBe(12);
    expect(new Date(Date.UTC(10, 0, 1, 12, 0, 0)).getUTCFullYear()).toBe(1910);
  });

  it("UTC year 0 stays 0, not 1900", () => {
    const parsed = parsePdfSpecDate("D:00000101120000Z");
    expect(parsed?.getUTCFullYear()).toBe(0);
    expect(new Date(Date.UTC(0, 0, 1, 12, 0, 0)).getUTCFullYear()).toBe(1900);
  });

  it("UTC year 99 stays 99, not 1999", () => {
    const parsed = parsePdfSpecDate("D:00991231120000Z");
    expect(parsed?.getUTCFullYear()).toBe(99);
    expect(parsed?.getUTCMonth()).toBe(11);
    expect(parsed?.getUTCDate()).toBe(31);
  });

  it("UTC year 0 Feb 29 is a real leap day, not 1900 overflow", () => {
    const parsed = parsePdfSpecDate("D:00000229120000Z");
    expect(parsed?.getUTCFullYear()).toBe(0);
    expect(parsed?.getUTCMonth()).toBe(1);
    expect(parsed?.getUTCDate()).toBe(29);
    const buggy = new Date(Date.UTC(0, 1, 29, 12, 0, 0));
    expect(buggy.getUTCFullYear()).toBe(1900);
    expect(buggy.getUTCDate()).not.toBe(29);
  });

  it("years >= 100 are unchanged vs Date.UTC", () => {
    const parsed = parsePdfSpecDate("D:20240531120000Z");
    expect(parsed?.toISOString()).toBe("2024-05-31T12:00:00.000Z");
  });

  it("no-timezone local branch keeps year 10 (not 1910)", () => {
    const parsed = parsePdfSpecDate("D:00100101120000");
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed?.getFullYear()).toBe(10);
    expect(parsed?.getMonth()).toBe(0);
    expect(parsed?.getDate()).toBe(1);
    expect(parsed?.getHours()).toBe(12);
    expect(new Date(10, 0, 1, 12, 0, 0).getFullYear()).toBe(1910);
  });

  it("returns undefined for non-spec strings", () => {
    expect(parsePdfSpecDate("2024-01-01")).toBeUndefined();
    expect(parsePdfSpecDate("D:abcd")).toBeUndefined();
  });
});

describe("parsePdfSpecDate rejects impossible calendar dates", () => {
  it("drops February 30 instead of overflowing into March", () => {
    // Per-field clamp allows day 30 (1–31), but February has no 30th.
    // Date.setUTCFullYear overflows to March 1; metadata must not invent that.
    expect(parsePdfSpecDate("D:20240230120000Z")).toBeUndefined();
    expect(parsePdfSpecDate("D:20240230120000+05'00'")).toBeUndefined();
    expect(parsePdfSpecDate("D:20240230120000")).toBeUndefined();
  });

  it("drops April 31 instead of overflowing into May", () => {
    expect(parsePdfSpecDate("D:20240431120000Z")).toBeUndefined();
  });

  it("drops February 29 in a non-leap year instead of overflowing into March", () => {
    expect(parsePdfSpecDate("D:20230229120000Z")).toBeUndefined();
    // Leap day in a leap year remains valid (year 0 and 2024 covered above).
    expect(parsePdfSpecDate("D:20240229120000Z")?.toISOString()).toBe(
      "2024-02-29T12:00:00.000Z",
    );
  });
});


describe("parsePdfSpecDate local timezone transitions", () => {
  it("preserves local spring-forward normalization without accepting impossible dates", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      expect(parsePdfSpecDate("D:20240310023000")?.toISOString()).toBe(
        "2024-03-10T07:30:00.000Z",
      );
      expect(parsePdfSpecDate("D:20240230023000")).toBeUndefined();
      expect(parsePdfSpecDate("D:20240310023000Z")?.toISOString()).toBe(
        "2024-03-10T02:30:00.000Z",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
