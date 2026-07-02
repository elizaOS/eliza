/**
 * Display-oriented DTOs shared by the Birdclaw service, routes, action, and
 * view. The birdclaw CLI's `--json` envelopes are richer than this (nested
 * author profiles, entities, inline SVG avatars); the service narrows them to
 * these flat rows at the parse boundary so every consumer renders display-only
 * data and never touches the raw wire shape.
 */

/** Tweet resources the birdclaw archive can list (`search tweets --resource`). */
export const BIRDCLAW_RESOURCES = ["home", "mentions", "authored"] as const;
export type BirdclawResource = (typeof BIRDCLAW_RESOURCES)[number];

/** Inbox kinds (`inbox --kind`). */
export const BIRDCLAW_INBOX_KINDS = ["mixed", "mentions", "dms"] as const;
export type BirdclawInboxKind = (typeof BIRDCLAW_INBOX_KINDS)[number];

/** Live collections a sync can refresh (`sync <collection>`). */
export const BIRDCLAW_SYNC_COLLECTIONS = [
  "timeline",
  "mentions",
  "authored",
  "likes",
  "bookmarks",
] as const;
export type BirdclawSyncCollection = (typeof BIRDCLAW_SYNC_COLLECTIONS)[number];

/** Digest periods (`digest [period]`). */
export const BIRDCLAW_DIGEST_PERIODS = [
  "today",
  "24h",
  "yesterday",
  "week",
] as const;
export type BirdclawDigestPeriod = (typeof BIRDCLAW_DIGEST_PERIODS)[number];

/** One archived tweet row, flattened for display. */
export interface BirdclawTweet {
  id: string;
  text: string;
  createdAt: string;
  authorHandle: string | null;
  authorName: string | null;
  likeCount: number | null;
  liked: boolean;
  bookmarked: boolean;
  isReplied: boolean | null;
  kind: string | null;
}

/** One ranked inbox item (mention or DM triage row), flattened for display. */
export interface BirdclawInboxItem {
  id: string;
  kind: string;
  title: string;
  text: string;
  createdAt: string;
  needsReply: boolean;
  score: number | null;
  participantHandle: string | null;
}

/** Dataset counts from `db stats`. */
export interface BirdclawCounts {
  home: number;
  mentions: number;
  dms: number;
  needsReply: number;
  inbox: number;
}

/** Live-transport state from `db stats` / `auth status`. */
export interface BirdclawTransport {
  installed: boolean;
  availableTransport: string;
  statusText: string;
}

/** Install + dataset status the view's setup/ready states render from. */
export interface BirdclawStatusInfo {
  installed: boolean;
  version: string | null;
  home: string | null;
  counts: BirdclawCounts | null;
  transport: BirdclawTransport | null;
  /** Human-readable reason when `installed` is false. */
  message: string | null;
}

/** Result of a `sync <collection>` run. */
export interface BirdclawSyncResult {
  collection: BirdclawSyncCollection;
  ok: boolean;
  /** One-line human summary of what the sync reported. */
  summary: string;
}

/** Result of a `digest` run (AI digest of the local archive). */
export interface BirdclawDigestResult {
  period: BirdclawDigestPeriod;
  text: string;
}

export function isBirdclawResource(value: string): value is BirdclawResource {
  return (BIRDCLAW_RESOURCES as readonly string[]).includes(value);
}

export function isBirdclawInboxKind(value: string): value is BirdclawInboxKind {
  return (BIRDCLAW_INBOX_KINDS as readonly string[]).includes(value);
}

export function isBirdclawSyncCollection(
  value: string,
): value is BirdclawSyncCollection {
  return (BIRDCLAW_SYNC_COLLECTIONS as readonly string[]).includes(value);
}

export function isBirdclawDigestPeriod(
  value: string,
): value is BirdclawDigestPeriod {
  return (BIRDCLAW_DIGEST_PERIODS as readonly string[]).includes(value);
}
