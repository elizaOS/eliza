/**
 * Conference-link extraction: the calendar feed's `meetLink` is the source of
 * `life_calendar_events.conference_link`, which drives meeting auto-join. The
 * video entry point must win over dial-in/SIP entries for third-party
 * conferences, and `hangoutLink` must always win when present.
 */

import type { calendar_v3 } from "googleapis";
import { describe, expect, it } from "vitest";
import { readConferenceLink } from "./calendar";

describe("readConferenceLink", () => {
  it("prefers hangoutLink when present", () => {
    const event = {
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      conferenceData: {
        entryPoints: [{ entryPointType: "phone", uri: "tel:+15551234567" }],
      },
    } as calendar_v3.Schema$Event;
    expect(readConferenceLink(event)).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("prefers the video entry point over phone/sip entries", () => {
    const event = {
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+15551234567" },
          { entryPointType: "sip", uri: "sip:12345@zoomcrc.com" },
          {
            entryPointType: "video",
            uri: "https://us02web.zoom.us/j/12345678901?pwd=secret",
          },
        ],
      },
    } as calendar_v3.Schema$Event;
    expect(readConferenceLink(event)).toBe("https://us02web.zoom.us/j/12345678901?pwd=secret");
  });

  it("falls back to the first entry point when no video entry exists", () => {
    const event = {
      conferenceData: {
        entryPoints: [{ entryPointType: "phone", uri: "tel:+15551234567" }],
      },
    } as calendar_v3.Schema$Event;
    expect(readConferenceLink(event)).toBe("tel:+15551234567");
  });

  it("returns undefined when the event carries no conference data", () => {
    expect(readConferenceLink({} as calendar_v3.Schema$Event)).toBeUndefined();
  });
});
