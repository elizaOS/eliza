/**
 * Pure Zoom Web Client page-state classification. The strategies extract
 * (title, body text, DOM booleans) from the page and pass them here so the
 * waiting-room / removal / auth-required / host-not-started decisions are
 * unit-testable without a browser. Decision rules ported from Vexa
 * (zoom/web/join.ts + admission.ts, Apache-2.0).
 */

import {
  zoomAuthRequiredTexts,
  zoomErrorPageTitle,
  zoomRemovalTexts,
  zoomWaitingRoomTexts,
} from "./selectors.js";

export type ZoomPageState =
  | "host_not_started"
  | "auth_required"
  | "waiting_room"
  | "removed_or_ended"
  | "in_meeting"
  | "pre_join"
  | "unknown";

export interface ZoomPageSnapshot {
  /** document.title */
  title: string;
  /** document.body.innerText */
  bodyText: string;
  /** Leave button visible (footer-only — never renders pre-join/lobby). */
  leaveButtonVisible: boolean;
  /** .meeting-app shell present. */
  meetingAppVisible: boolean;
  /** Count of playing <audio> elements with a live MediaStream track. */
  liveAudioCount: number;
  /** Name input / join button / passcode input present. */
  preJoinControlsPresent: boolean;
}

export function isZoomWaitingRoomText(bodyText: string): boolean {
  return zoomWaitingRoomTexts.some((t) => bodyText.includes(t));
}

export function isZoomRemovalText(bodyText: string): boolean {
  return zoomRemovalTexts.some((t) => bodyText.includes(t));
}

export function isZoomAuthRequiredText(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return zoomAuthRequiredTexts.some((t) => lower.includes(t));
}

export function isZoomHostNotStarted(title: string): boolean {
  return title === zoomErrorPageTitle || title === "error - Zoom";
}

/**
 * Classify a snapshot. Ordering matters and mirrors Vexa's hard-won rules:
 *  1. Leave button = strong positive, trusted unconditionally.
 *  2. Waiting-room text excludes BOTH weaker in-meeting fallbacks: Zoom
 *     renders the waiting room INSIDE .meeting-app, and the bot's mic
 *     preview keeps <audio> elements live across pre-join → waiting-room.
 *  3. Live audio only counts as in-meeting when no pre-join controls remain
 *     (the pre-join page itself preloads mic-preview audio).
 */
export function classifyZoomPage(snapshot: ZoomPageSnapshot): ZoomPageState {
  if (snapshot.leaveButtonVisible) return "in_meeting";
  if (isZoomRemovalText(snapshot.bodyText)) return "removed_or_ended";
  if (isZoomAuthRequiredText(snapshot.bodyText)) return "auth_required";
  if (isZoomHostNotStarted(snapshot.title)) return "host_not_started";
  if (isZoomWaitingRoomText(snapshot.bodyText)) return "waiting_room";
  if (snapshot.meetingAppVisible) return "in_meeting";
  if (snapshot.liveAudioCount > 0 && !snapshot.preJoinControlsPresent)
    return "in_meeting";
  if (snapshot.preJoinControlsPresent) return "pre_join";
  return "unknown";
}

/**
 * URL patterns in Zoom's normal join/audio-init redirect sequence — these
 * must NOT be treated as removal (transient navigations during handshake).
 */
const ZOOM_AUDIO_INIT_URL_PATTERNS = [
  /\/wc\/\d+\/join/,
  /\/wc\/\d+\/start/,
  /\/wc-loading\//,
  /\/wc\/\d+\/videomeeting/,
];

export function isZoomAudioInitUrl(url: string): boolean {
  return ZOOM_AUDIO_INIT_URL_PATTERNS.some((pattern) => pattern.test(url));
}

const ZOOM_DOMAIN_RE =
  /zoom\.(us|com|eu|com\.cn|com\.br|com\.au|de|fr|jp|ca|co\.uk)\b/;

export function isZoomDomainUrl(url: string): boolean {
  return ZOOM_DOMAIN_RE.test(url);
}
