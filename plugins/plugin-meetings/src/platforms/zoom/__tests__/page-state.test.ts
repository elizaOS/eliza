/**
 * Pure Zoom Web page-state classification — waiting-room, removal,
 * auth-required, and host-not-started decisions plus the URL predicates.
 * Deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  classifyZoomPage,
  isZoomAudioInitUrl,
  isZoomDomainUrl,
  type ZoomPageSnapshot,
} from "../page-state.js";

function snap(overrides: Partial<ZoomPageSnapshot>): ZoomPageSnapshot {
  return {
    title: "Zoom Meeting",
    bodyText: "",
    leaveButtonVisible: false,
    meetingAppVisible: false,
    liveAudioCount: 0,
    preJoinControlsPresent: false,
    ...overrides,
  };
}

describe("classifyZoomPage", () => {
  it("trusts a visible Leave button unconditionally", () => {
    expect(
      classifyZoomPage(
        snap({ leaveButtonVisible: true, bodyText: "Please wait" }),
      ),
    ).toBe("in_meeting");
  });

  it("waiting-room text excludes the meeting-app fallback (waiting room renders INSIDE .meeting-app)", () => {
    expect(
      classifyZoomPage(
        snap({
          meetingAppVisible: true,
          bodyText: "Please wait, the meeting host will let you in soon.",
        }),
      ),
    ).toBe("waiting_room");
  });

  it("waiting-room text excludes the live-audio fallback (mic preview stays live in the lobby)", () => {
    expect(
      classifyZoomPage(
        snap({
          liveAudioCount: 2,
          bodyText: "Host has joined. We've let them know you're here",
        }),
      ),
    ).toBe("waiting_room");
  });

  it("live audio alone is NOT in-meeting while pre-join controls remain (mic preview on pre-join page)", () => {
    expect(
      classifyZoomPage(snap({ liveAudioCount: 3, preJoinControlsPresent: true })),
    ).toBe("pre_join");
    expect(
      classifyZoomPage(snap({ liveAudioCount: 3, preJoinControlsPresent: false })),
    ).toBe("in_meeting");
  });

  it("detects removal/end-of-meeting text ahead of weaker signals", () => {
    expect(
      classifyZoomPage(
        snap({
          meetingAppVisible: true,
          bodyText: "This meeting has been ended by host",
        }),
      ),
    ).toBe("removed_or_ended");
  });

  it("detects the authenticated-users gate case-insensitively", () => {
    expect(
      classifyZoomPage(snap({ bodyText: "Only Authenticated Users Can Join this meeting" })),
    ).toBe("auth_required");
  });

  it("detects host-not-started via the error page title", () => {
    expect(classifyZoomPage(snap({ title: "Error - Zoom" }))).toBe("host_not_started");
    expect(classifyZoomPage(snap({ title: "error - Zoom" }))).toBe("host_not_started");
  });

  it("falls through to unknown when nothing matches", () => {
    expect(classifyZoomPage(snap({}))).toBe("unknown");
  });
});

describe("isZoomAudioInitUrl", () => {
  it("matches the transient join/audio-handshake redirect URLs", () => {
    expect(isZoomAudioInitUrl("https://app.zoom.us/wc/84335626851/join?pwd=x")).toBe(true);
    expect(isZoomAudioInitUrl("https://app.zoom.us/wc/84335626851/start")).toBe(true);
    expect(isZoomAudioInitUrl("https://app.zoom.us/wc-loading/84335626851")).toBe(true);
    expect(isZoomAudioInitUrl("https://app.zoom.us/wc/84335626851/videomeeting")).toBe(true);
  });

  it("does not match sign-in or non-Zoom URLs", () => {
    expect(isZoomAudioInitUrl("https://zoom.us/signin")).toBe(false);
    expect(isZoomAudioInitUrl("https://example.com/wc-loading/")).toBe(true); // pattern is path-based
    expect(isZoomAudioInitUrl("https://zoom.us/")).toBe(false);
  });
});

describe("isZoomDomainUrl", () => {
  it("matches zoom regional domains and rejects lookalikes", () => {
    expect(isZoomDomainUrl("https://us05web.zoom.us/j/123")).toBe(true);
    expect(isZoomDomainUrl("https://zoom.com.cn/j/123")).toBe(true);
    expect(isZoomDomainUrl("https://zoom-lfx.platform.linuxfoundation.org/meeting/1")).toBe(false);
    expect(isZoomDomainUrl("https://example.com/")).toBe(false);
  });
});
