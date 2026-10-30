/**
 * Coverage for the planner "Z" time-zone alias in timezone.ts, and for the
 * free-text scan reading a zone only where the text names one.
 *
 * A planner that reads an ISO timestamp such as "2026-08-19T14:00:00Z"
 * stamps the definition timeZone field "Z". The exact-token path
 * (normalizeExplicitTimeZoneToken) must resolve it to UTC, because Intl
 * rejects "Z" as a zone name and callers otherwise fall back to the owner
 * default zone. The alias must not leak into the free-text scan
 * (extractExplicitTimeZoneFromText / inferTimeZoneFromLocationText): a
 * bare "z" in prose is not a time zone, and inferring UTC there would
 * override the owner's meeting time zone.
 */

import { describe, expect, it } from "vitest";
import {
  extractExplicitTimeZoneFromText,
  inferTimeZoneFromLocationText,
  normalizeExplicitTimeZoneToken,
} from "./timezone.js";

describe("normalizeExplicitTimeZoneToken planner Z alias", () => {
  it("resolves the exact token Z to UTC", () => {
    expect(normalizeExplicitTimeZoneToken("Z")).toBe("UTC");
    expect(normalizeExplicitTimeZoneToken("z")).toBe("UTC");
    expect(normalizeExplicitTimeZoneToken("  Z  ")).toBe("UTC");
  });

  it("returns null for an unknown token", () => {
    expect(normalizeExplicitTimeZoneToken("not-a-zone")).toBeNull();
    expect(normalizeExplicitTimeZoneToken("")).toBeNull();
    expect(normalizeExplicitTimeZoneToken(null)).toBeNull();
  });
});

describe("free-text time-zone scan ignores a bare z", () => {
  const prose = [
    "find three slots to meet Jay Z next week",
    "Gen Z roundtable with Dana",
    "cover everything from A-Z with Sam",
  ];

  it("infers no zone from prose that contains a bare z", () => {
    for (const sentence of prose) {
      expect(extractExplicitTimeZoneFromText(sentence)).toBeNull();
      expect(inferTimeZoneFromLocationText(sentence)).toBeNull();
    }
  });
});

describe("free-text time-zone scan ignores ordinary words", () => {
  // Each sentence holds a word that is also a zone alias ("CT", "PT",
  // "central", "mountain", "Denver") or the last segment of an IANA zone name
  // (Antarctica/Casey, Indian/Christmas, Pacific/Wake,
  // America/North_Dakota/Center). None of them names a zone here.
  it.each([
    "remind me about my CT scan tomorrow at 10am",
    "book a PT session every monday at 9am",
    "go for a run in Central Park tomorrow at 7am",
    "go mountain biking saturday at 8am",
    "call Denver back tomorrow at 5pm",
    "find three slots to meet Casey next week",
    "propose times for the Christmas party sync next week",
    "find a slot after I wake up tomorrow",
    "coffee at the community center next week",
    // A bare number before the word is a count, not a clock time.
    "book 2 mountain bike sessions saturday at 8am",
    "remind me to buy 2 Central Park Zoo tickets tomorrow at 10am",
    "find 2 pacific coast trail hikes next week",
    "order 3 Berlin guidebooks next week",
  ])("infers no zone from %j", (sentence) => {
    expect(extractExplicitTimeZoneFromText(sentence)).toBeNull();
    expect(inferTimeZoneFromLocationText(sentence)).toBeNull();
  });
});

describe("free-text time-zone scan reads a zone where the text names one", () => {
  it.each([
    ["call mom at 10am PT", "America/Los_Angeles"],
    ["call the bank at 9 a.m. PT", "America/Los_Angeles"],
    ["standup at 3:30 central", "America/Chicago"],
    ["dentist at 9 am Eastern time", "America/New_York"],
    ["sync at 2pm mountain time", "America/Denver"],
    ["review at 4pm EST", "America/New_York"],
    ["meet at 5pm New York time", "America/New_York"],
    ["remind me at 9am while I'm in Chicago", "America/Chicago"],
    ["standup at 5 central", "America/Chicago"],
    ["send the report by 5 ET", "America/New_York"],
    ["remind me at noon PT", "America/Los_Angeles"],
    ["call at midnight PT", "America/Los_Angeles"],
    ["standup at 5 o'clock PT", "America/Los_Angeles"],
    ["call at noon Pacific", "America/Los_Angeles"],
    ["lunch at noon eastern", "America/New_York"],
    ["call at 10am, PT", "America/Los_Angeles"],
  ])("reads %j as %s", (sentence, timeZone) => {
    expect(extractExplicitTimeZoneFromText(sentence)).toBe(timeZone);
  });

  it.each([
    ["while I'm in Tokyo next week find slots with Ryan", "Asia/Tokyo"],
    ["while I'm in Tokyo, find three slots with Ryan", "Asia/Tokyo"],
    ["find three slots, Berlin time", "Europe/Berlin"],
    ["Tokyo", "Asia/Tokyo"],
  ])("infers %j as %s", (sentence, timeZone) => {
    expect(inferTimeZoneFromLocationText(sentence)).toBe(timeZone);
  });
});
