/**
 * Unit coverage for `parseMeetingUrl` (`meetings.ts`): platform detection and
 * native-id canonicalization for Google Meet / Teams / Zoom links, plus the
 * malformed percent-escape Teams id that must return null rather than throw a
 * URIError (which previously crashed the Transcripts/Calendar views).
 */
import { describe, expect, it } from "vitest";
import { parseMeetingUrl } from "./meetings.js";

describe("parseMeetingUrl", () => {
  it("parses a Google Meet link and canonicalizes the id", () => {
    expect(parseMeetingUrl("https://meet.google.com/abc-defg-hij")).toEqual({
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      nativeMeetingId: "abc-defg-hij",
    });
  });

  it("lowercases the Meet id so case cannot bypass already_joined dedup", () => {
    // MEET_URL_RE is case-insensitive; two spellings must collide on one id.
    const upper = parseMeetingUrl("https://meet.google.com/ABC-DEFG-HIJ");
    const lower = parseMeetingUrl("https://meet.google.com/abc-defg-hij");
    expect(upper?.nativeMeetingId).toBe("abc-defg-hij");
    expect(upper?.nativeMeetingId).toBe(lower?.nativeMeetingId);
  });

  it("parses a Teams meetup-join link and decodes the id", () => {
    // The id capture group is the full path segment after meetup-join/, so the
    // trailing `/0` (thread message id) is part of the decoded native id.
    const parsed = parseMeetingUrl(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
    );
    expect(parsed?.platform).toBe("teams");
    expect(parsed?.nativeMeetingId).toBe("19:meeting_abc@thread.v2/0");
  });

  it("returns null (never throws URIError) on a malformed percent-escape Teams id", () => {
    // A lone trailing `%` is an invalid escape: decodeURIComponent throws
    // URIError, which used to crash the Transcripts view on every keystroke,
    // CalendarView, JOIN_MEETING.validate and POST /api/meetings.
    expect(() =>
      parseMeetingUrl(
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%",
      ),
    ).not.toThrow();
    expect(
      parseMeetingUrl(
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%",
      ),
    ).toBeNull();
  });

  it("parses a Zoom web-client join link, preserving pwd", () => {
    const parsed = parseMeetingUrl("https://zoom.us/j/123456789?pwd=secret");
    expect(parsed?.platform).toBe("zoom");
    expect(parsed?.nativeMeetingId).toBe("123456789");
    expect(parsed?.meetingUrl).toBe(
      "https://app.zoom.us/wc/123456789/join?pwd=secret",
    );
  });

  it("returns null for an unrecognized URL", () => {
    expect(parseMeetingUrl("https://example.com/not-a-meeting")).toBeNull();
    expect(parseMeetingUrl("")).toBeNull();
  });
});
