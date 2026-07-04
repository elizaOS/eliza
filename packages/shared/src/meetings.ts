/**
 * Meetings — the canonical contract for agent-attended meetings.
 *
 * One shape shared across every layer: the meeting bot that JOINS a call
 * (plugin-meetings platform adapters), the pipeline that TRANSCRIBES it into
 * `Transcript` records (see ./transcripts.ts), the API routes + client that
 * TRANSPORT session state, and the UI that renders live + archived meeting
 * transcripts. Pure, browser- + node-safe: types, constants, and URL parsing
 * only — no runtime imports.
 *
 * Platform bots join as anonymous guests (bot name only, no OAuth); calendar
 * integration and post-hoc artifacts remain the OAuth surfaces.
 */

import type { TranscriptSegment } from "./transcripts.js";

/** Platforms an agent can attend. Browser-bot: meet/teams/zoom. Native RX: discord. */
export type MeetingPlatform = "google_meet" | "teams" | "zoom" | "discord";

export const MEETING_PLATFORMS: readonly MeetingPlatform[] = [
  "google_meet",
  "teams",
  "zoom",
  "discord",
];

/** Lifecycle of one attended meeting session. */
export type MeetingSessionStatus =
  | "requested"
  | "joining"
  | "awaiting_admission"
  | "active"
  | "leaving"
  | "ended"
  | "failed";

/** Why a session left/ended (mirrors the platform flow's leave reasons). */
export type MeetingEndReason =
  | "normal_completion"
  | "requested_stop"
  | "duration_cap_reached"
  | "removed_by_admin"
  | "left_alone_timeout"
  | "startup_alone_timeout"
  | "admission_timeout"
  | "admission_rejected"
  | "join_failed"
  | "error";

/** Auto-leave timeouts, all milliseconds. */
export interface MeetingAutoLeaveConfig {
  /** Give up if not admitted from the waiting room within this window. */
  waitingRoomTimeoutMs: number;
  /** Leave if nobody else ever joined. */
  noOneJoinedTimeoutMs: number;
  /** Leave after everyone else has left. */
  everyoneLeftTimeoutMs: number;
}

export const DEFAULT_MEETING_AUTO_LEAVE: MeetingAutoLeaveConfig = {
  waitingRoomTimeoutMs: 5 * 60 * 1000,
  noOneJoinedTimeoutMs: 10 * 60 * 1000,
  everyoneLeftTimeoutMs: 2 * 60 * 1000,
};

/** Default upper bound for a browser-bot meeting session: 60 minutes. */
export const DEFAULT_MEETING_MAX_DURATION_MS = 60 * 60 * 1000;

/** Input contract to start a bot (the request side of POST /api/meetings). */
export interface MeetingJoinRequest {
  platform: MeetingPlatform;
  meetingUrl: string;
  /** Display name the bot joins under. */
  botName?: string;
  /** BCP-47 hint for ASR; auto-detect when absent. */
  language?: string;
  autoLeave?: Partial<MeetingAutoLeaveConfig>;
  /** Retain the meeting audio on the transcript record (default true). */
  retainAudio?: boolean;
  /**
   * Optional lower per-session cap in milliseconds. The service rejects values
   * above its configured maximum before launching the bot.
   */
  maxDurationMs?: number;
  /** Calendar event that prompted the join, when auto-joined. */
  calendarEventId?: string;
}

/** A participant observed in the meeting roster. */
export interface MeetingParticipant {
  /** Stable id within the session (platform participant id or synthesized). */
  id: string;
  displayName: string;
  /** Resolved elizaOS entity id, when identity binding succeeded. */
  entityId?: string;
  joinedAtMs?: number;
  leftAtMs?: number;
}

/** One attended meeting session — the API/UI projection of bot state. */
export interface MeetingSession {
  id: string;
  platform: MeetingPlatform;
  meetingUrl: string;
  /** Platform-native meeting id (e.g. Meet's xxx-xxxx-xxx). */
  nativeMeetingId: string;
  botName: string;
  status: MeetingSessionStatus;
  endReason?: MeetingEndReason;
  /** Present when status is "failed" (or ended with error). */
  errorMessage?: string;
  /** Epoch ms timestamps for the lifecycle edges. */
  requestedAt: number;
  activeAt?: number;
  endedAt?: number;
  /** elizaOS room this meeting's memories/transcript hang off. */
  roomId?: string;
  /** The live/final Transcript record id (source "meeting"). */
  transcriptId?: string;
  participants: MeetingParticipant[];
  calendarEventId?: string;
  /** Maximum duration approved for this session, in milliseconds. */
  maxDurationMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Live transcript event pushed over the agent WebSocket while a meeting is
 * active. `confirmed` segments are stable (LocalAgreement-confirmed);
 * `pending` is the mutable tail and replaces any prior pending state.
 */
export interface MeetingTranscriptEvent {
  type: "meeting-transcript";
  sessionId: string;
  transcriptId: string;
  confirmed: TranscriptSegment[];
  pending: TranscriptSegment[];
}

/** Session lifecycle event pushed over the agent WebSocket. */
export interface MeetingStatusEvent {
  type: "meeting-status";
  session: MeetingSession;
}

export type MeetingWsEvent = MeetingTranscriptEvent | MeetingStatusEvent;

/** Result of parsing a user-supplied meeting URL. */
export interface ParsedMeetingUrl {
  platform: MeetingPlatform;
  /** Canonical URL the bot should navigate to. */
  meetingUrl: string;
  nativeMeetingId: string;
}

/**
 * Percent-decode a URL segment, returning null (never throwing) on a malformed
 * escape like a lone `%`. `decodeURIComponent` throws `URIError` on such input,
 * and this parser runs on every keystroke in the Transcripts view + inside
 * JOIN_MEETING.validate and POST /api/meetings, so a bad character must degrade
 * to "not a recognizable meeting link", not crash the surface.
 */
function safeDecodeUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // error-policy:J3 malformed percent-escape -> not a recognizable link
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
 * URLs that are not a recognizable Meet/Teams/Zoom meeting link. Discord
 * "meetings" are voice channels and never arrive as URLs here.
 */
export function parseMeetingUrl(raw: string): ParsedMeetingUrl | null {
  const url = raw.trim();
  const meet = MEET_URL_RE.exec(url);
  if (meet) {
    // MEET_URL_RE is case-insensitive, so lowercase the parsed id before
    // canonicalizing — otherwise `ABC-DEFG-HIJ` and `abc-defg-hij` produce
    // different native ids and the already_joined dedup can be bypassed by case.
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
    // The web client join URL; preserves ?pwd= and other params.
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

/** Human-readable platform names for UI badges and logs. */
export const MEETING_PLATFORM_LABELS: Record<MeetingPlatform, string> = {
  google_meet: "Google Meet",
  teams: "Microsoft Teams",
  zoom: "Zoom",
  discord: "Discord",
};
