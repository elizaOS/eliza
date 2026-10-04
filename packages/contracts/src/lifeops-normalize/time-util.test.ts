import { describe, expect, it } from "vitest";
import { parseUnambiguousZonedDateTime } from "./time-util.js";

describe("parseUnambiguousZonedDateTime", () => {
  it.each([
    ["2026-10-04T12:00", "UTC", "2026-10-04T12:00:00Z"],
    ["2026-10-04T12:00", "America/Los_Angeles", "2026-10-04T19:00:00Z"],
    ["2026-01-04T12:00", "America/Los_Angeles", "2026-01-04T20:00:00Z"],
    ["2026-10-04T12:00", "Asia/Kathmandu", "2026-10-04T06:15:00Z"],
    ["2026-10-04T12:00", "Pacific/Chatham", "2026-10-03T22:15:00Z"],
    ["2028-02-29T00:00", "UTC", "2028-02-29T00:00:00Z"],
    ["0001-01-01T00:00", "UTC", "0001-01-01T00:00:00Z"],
    ["0099-12-31T23:59", "UTC", "0099-12-31T23:59:00Z"],
    ["9999-12-31T23:59", "UTC", "9999-12-31T23:59:00Z"],
  ])("resolves %s in %s exactly", (local, zone, expected) => {
    expect(parseUnambiguousZonedDateTime(local, zone)).toBe(
      Date.parse(expected),
    );
  });

  it.each([
    ["2026-03-08T02:30", "America/New_York"],
    ["2026-11-01T01:30", "America/New_York"],
    ["2026-10-04T02:15", "Australia/Lord_Howe"],
    ["2026-04-05T01:45", "Australia/Lord_Howe"],
    ["2011-12-30T12:00", "Pacific/Apia"],
  ])("does not guess an offset for %s in %s", (local, zone) => {
    expect(parseUnambiguousZonedDateTime(local, zone)).toBeNull();
  });

  it.each([
    "2026-02-29T12:00",
    "2026-04-31T12:00",
    "2026-00-10T12:00",
    "2026-13-10T12:00",
    "2026-10-00T12:00",
    "2026-10-04T24:00",
    "2026-10-04T12:60",
    "0000-01-01T00:00",
    "2026-10-04T12:00Z",
    "2026-10-04T12:00:00",
    "2026-10-04 12:00",
    " 2026-10-04T12:00",
    null,
    undefined,
    1791144000000,
    {},
  ])("rejects malformed calendar input %j", (value) => {
    expect(parseUnambiguousZonedDateTime(value, "UTC")).toBeNull();
  });

  it.each(["Not/AZone", "", "   ", null, undefined, {}, 0])(
    "never defaults invalid zone %j",
    (zone) => {
      expect(
        parseUnambiguousZonedDateTime("2026-10-04T12:00", zone),
      ).toBeNull();
    },
  );
});
