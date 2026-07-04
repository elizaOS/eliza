// Meeting-URL parsing for the calendar VIEW BUNDLE.
//
// This is a browser-only copy of `@elizaos/shared`'s `parseMeetingUrl`. View
// bundles externalize `@elizaos/shared` (see packages/scripts/view-bundle-vite.config.ts)
// and the DynamicViewLoader does not provide it, so a runtime
// `import { parseMeetingUrl } from "@elizaos/shared"` in CalendarView left an
// unresolvable bare specifier and broke the calendar view bundle load. The
// logic is a small, stable pure function, so the view carries its own copy
// rather than pulling the shared runtime into the bundle. Keep in sync with
// packages/shared/src/meetings.ts.

export type MeetingPlatform = "google_meet" | "teams" | "zoom" | "discord";

export interface ParsedMeetingUrl {
  platform: MeetingPlatform;
  /** Canonical URL the bot should navigate to. */
  meetingUrl: string;
  nativeMeetingId: string;
}

/**
 * Percent-decode a URL segment, returning null (never throwing) on a malformed
 * escape like a lone `%`. `decodeURIComponent` throws `URIError` on such input.
 */
function safeDecodeUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const MEET_URL_RE =
  /^https?:\/\/meet\.google\.com\/([a-z]{3}-?[a-z]{4}-?[a-z]{3})(?:\?.*)?$/i;
const TEAMS_URL_RE =
  /^https?:\/\/(?:[\w-]+\.)?teams\.(?:microsoft|live)\.com\/(?:v2\/)?(?:l\/)?meet(?:up-join)?\/([^?\s]+)/i;
const TEAMS_SHORT_RE = /^https?:\/\/teams\.microsoft\.com\/meet\/(\d+)/i;
const ZOOM_URL_RE =
  /^https?:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|w|wc)\/(?:join\/)?(\d{9,12})(?:[/?]|$)/i;
const ZOOM_APP_RE = /^https?:\/\/app\.zoom\.us\/wc\/(\d{9,12})\/join/i;

/**
 * Classify a meeting URL and extract the platform-native id. Returns null for
 * URLs that are not a recognizable Meet/Teams/Zoom meeting link.
 */
export function parseMeetingUrl(raw: string): ParsedMeetingUrl | null {
  const url = raw.trim();
  const meet = MEET_URL_RE.exec(url);
  if (meet) {
    const id = meet[1].toLowerCase().replace(/-/g, "");
    const canonical = `${id.slice(0, 3)}-${id.slice(3, 7)}-${id.slice(7)}`;
    return {
      platform: "google_meet",
      meetingUrl: `https://meet.google.com/${canonical}`,
      nativeMeetingId: canonical,
    };
  }
  const zoomApp = ZOOM_APP_RE.exec(url);
  if (zoomApp) {
    return { platform: "zoom", meetingUrl: url, nativeMeetingId: zoomApp[1] };
  }
  const zoom = ZOOM_URL_RE.exec(url);
  if (zoom) {
    const parsed = new URL(url);
    const pwd = parsed.searchParams.get("pwd");
    const joinUrl = `https://app.zoom.us/wc/${zoom[1]}/join${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ""}`;
    return { platform: "zoom", meetingUrl: joinUrl, nativeMeetingId: zoom[1] };
  }
  const teamsShort = TEAMS_SHORT_RE.exec(url);
  if (teamsShort) {
    return {
      platform: "teams",
      meetingUrl: url,
      nativeMeetingId: teamsShort[1],
    };
  }
  const teams = TEAMS_URL_RE.exec(url);
  if (teams) {
    const decoded = safeDecodeUriComponent(teams[1]);
    if (decoded === null) return null;
    return {
      platform: "teams",
      meetingUrl: url,
      nativeMeetingId: decoded.slice(0, 128),
    };
  }
  return null;
}
