import { describe, expect, it } from "vitest";
import { parsePdfSpecDate } from "./pdf-date";

describe("parsePdfSpecDate", () => {
  it("parses a full UTC-suffixed spec date", () => {
    const d = parsePdfSpecDate("D:20240815123045Z");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getUTCFullYear()).toBe(2024);
    expect(d!.getUTCMonth()).toBe(7); // August
    expect(d!.getUTCDate()).toBe(15);
    expect(d!.getUTCHours()).toBe(12);
    expect(d!.getUTCMinutes()).toBe(30);
    expect(d!.getUTCSeconds()).toBe(45);
  });

  it("applies a positive UT offset by subtracting it", () => {
    const d = parsePdfSpecDate("D:20240815123045+0500");
    expect(d!.getUTCHours()).toBe(7);
    expect(d!.getUTCMinutes()).toBe(30);
    expect(d!.getUTCDate()).toBe(15);
  });

  it("applies a negative UT offset by adding it", () => {
    const d = parsePdfSpecDate("D:20240815123045-0500");
    expect(d!.getUTCHours()).toBe(17);
    expect(d!.getUTCMinutes()).toBe(30);
  });

  it("handles half-hour offsets", () => {
    const d = parsePdfSpecDate("D:20240815123045+0530");
    expect(d!.getUTCHours()).toBe(7);
    expect(d!.getUTCMinutes()).toBe(0);
  });

  it("carries an offset across the midnight boundary", () => {
    const d = parsePdfSpecDate("D:20240815000000+1400");
    expect(d!.getUTCDate()).toBe(14);
    expect(d!.getUTCHours()).toBe(10);
  });

  it("interprets a missing UT relation as host-local wall clock", () => {
    const d = parsePdfSpecDate("D:20240815");
    expect(d!.getFullYear()).toBe(2024);
    expect(d!.getMonth()).toBe(7);
    expect(d!.getDate()).toBe(15);
  });

  it("defaults missing time fields to zero", () => {
    const d = parsePdfSpecDate("D:2024081512Z");
    expect(d!.getUTCMinutes()).toBe(0);
    expect(d!.getUTCSeconds()).toBe(0);
  });

  it("defaults missing month and day fields to January 1st", () => {
    const d = parsePdfSpecDate("D:2024Z");
    expect(d!.getUTCMonth()).toBe(0);
    expect(d!.getUTCDate()).toBe(1);
  });

  it("keeps years 0-99 intact (setUTCFullYear semantics)", () => {
    const d = parsePdfSpecDate("D:00101231Z");
    expect(d!.getUTCFullYear()).toBe(10);
    expect(d!.getUTCMonth()).toBe(11);
    expect(d!.getUTCDate()).toBe(31);
  });

  it("accepts leap-year February 29", () => {
    const d = parsePdfSpecDate("D:20240229Z");
    expect(d!.getUTCMonth()).toBe(1);
    expect(d!.getUTCDate()).toBe(29);
  });

  it("clamps out-of-range month to January", () => {
    const d = parsePdfSpecDate("D:20241315Z");
    expect(d!.getUTCMonth()).toBe(0);
  });

  it("clamps out-of-range hour to zero", () => {
    const d = parsePdfSpecDate("D:20240815250000Z");
    expect(d!.getUTCHours()).toBe(0);
  });

  it("clamps out-of-range seconds to zero", () => {
    const d = parsePdfSpecDate("D:20240815123099Z");
    expect(d!.getUTCSeconds()).toBe(0);
  });

  // Documented degenerate case: an impossible calendar date (Feb 29 in a
  // non-leap year) is accepted and rolls over to March 1 rather than being
  // rejected — current parser behavior, pinned for regressions.
  it("rolls an impossible Feb 29 in a non-leap year to March 1", () => {
    const d = parsePdfSpecDate("D:20230229Z");
    expect(d!.getUTCMonth()).toBe(2);
    expect(d!.getUTCDate()).toBe(1);
  });

  it("interprets a relation-less full date as host-local wall clock", () => {
    const d = parsePdfSpecDate("D:20240815123045");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2024);
    expect(d!.getMonth()).toBe(7);
    expect(d!.getHours()).toBe(12);
    expect(d!.getMinutes()).toBe(30);
  });

  it("returns undefined for non-spec strings", () => {
    expect(parsePdfSpecDate("2024-08-15")).toBeUndefined();
    expect(parsePdfSpecDate("D:")).toBeUndefined();
    expect(parsePdfSpecDate("D:abc")).toBeUndefined();
    expect(parsePdfSpecDate("")).toBeUndefined();
  });
});
