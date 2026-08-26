/**
 * Per-channel Slack membership evidence: snapshots of `conversations.members`
 * for admitted channels, join/leave deltas derived from Bolt events, and
 * explicit unavailable states for scope/permission/pagination failures.
 *
 * Slack never returns an empty roster to mean "cannot read" — every failure
 * mode (missing scope, not-a-member, channel gone, rate limit) must surface
 * as a typed unavailable result, never as an empty member list. Snapshot
 * paging is terminal-cursor based: only an absent `next_cursor` completes a
 * snapshot; any mid-walk failure invalidates the whole walk.
 */
import type { WebClient } from "@slack/web-api";

export const SLACK_MEMBERS_PAGE_LIMIT = 200;

/** Classified failure modes for a membership read attempt. */
export type SlackMembershipUnavailableReason =
  | "client_not_initialized"
  | "channel_not_admitted"
  | "missing_scope"
  | "not_a_member"
  | "channel_not_found"
  | "rate_limited"
  | "pagination_loop"
  | "malformed_response"
  | "request_failed";

/** A completed snapshot walk. `memberIds` may legitimately be empty. */
export interface SlackMembershipSnapshot {
  readonly kind: "snapshot";
  readonly channelId: string;
  readonly memberIds: readonly string[];
  readonly completedPages: number;
  readonly observedAt: string;
}

/**
 * A read that cannot produce trustworthy membership evidence. Callers must
 * treat prior knowledge as stale, not revoke members, and never report an
 * empty roster on top of this state.
 */
export interface SlackMembershipUnavailable {
  readonly kind: "unavailable";
  readonly channelId: string;
  readonly reason: SlackMembershipUnavailableReason;
  readonly slackErrorCode: string | undefined;
}

export type SlackMembershipReadResult =
  | SlackMembershipSnapshot
  | SlackMembershipUnavailable;

interface SlackMembersPage {
  members?: unknown;
  response_metadata?: { next_cursor?: unknown };
  error?: { code?: unknown };
}

/**
 * Maps a failed `conversations.members` call onto a classified reason.
 * `missing_scope` / `not_allowed` mean the app lacks read scopes;
 * `channel_not_found` means the channel is gone or invisible;
 * `not_in_channel` / `method_not_supported_for_channel_type` mean the bot
 * cannot read this channel's roster; `ratelimited` is transient.
 */
export function classifyMembershipFailure(error: unknown): {
  reason: SlackMembershipUnavailableReason;
  slackErrorCode: string | undefined;
} {
  const slackError =
    typeof error === "object" && error !== null
      ? (error as { data?: { code?: unknown }; code?: unknown })
      : {};
  const code =
    typeof slackError.code === "string"
      ? slackError.code
      : typeof slackError.data?.code === "string"
        ? slackError.data.code
        : undefined;
  switch (code) {
    case "missing_scope":
    case "not_allowed":
    case "admin_only_channel":
      return { reason: "missing_scope", slackErrorCode: code };
    case "channel_not_found":
    case "channel_is_archived":
      return { reason: "channel_not_found", slackErrorCode: code };
    case "not_in_channel":
    case "method_not_supported_for_channel_type":
      return { reason: "not_a_member", slackErrorCode: code };
    case "ratelimited":
      return { reason: "rate_limited", slackErrorCode: code };
    case "invalid_cursor":
      return { reason: "pagination_loop", slackErrorCode: code };
    default:
      return { reason: "request_failed", slackErrorCode: code };
  }
}

function extractPageError(page: SlackMembersPage): string | undefined {
  return typeof page.error === "object" && page.error !== null
    ? typeof (page.error as { code?: unknown }).code === "string"
      ? (page.error as { code: string }).code
      : undefined
    : typeof page.error === "string"
      ? page.error
      : undefined;
}

/**
 * Walks `conversations.members` to a terminal page and returns either a
 * complete snapshot or a classified unavailable state. Any page failure,
 * repeated cursor, or malformed member entry aborts the whole walk — partial
 * rosters are never reported as complete.
 */
export async function readChannelMembershipSnapshot(
  client: WebClient,
  channelId: string,
): Promise<SlackMembershipReadResult> {
  const memberIds: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    let page: SlackMembersPage;
    try {
      page = (await client.conversations.members({
        channel: channelId,
        limit: SLACK_MEMBERS_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      })) as unknown as SlackMembersPage;
    } catch (error) {
      const { reason, slackErrorCode } = classifyMembershipFailure(error);
      return {
        kind: "unavailable",
        channelId,
        reason,
        slackErrorCode,
      };
    }

    const pageError = extractPageError(page);
    if (pageError) {
      const { reason, slackErrorCode } = classifyMembershipFailure({
        code: pageError,
      });
      return { kind: "unavailable", channelId, reason, slackErrorCode };
    }

    const rawMembers = Array.isArray(page.members) ? page.members : null;
    if (!rawMembers) {
      return {
        kind: "unavailable",
        channelId,
        reason: "malformed_response",
        slackErrorCode: undefined,
      };
    }
    for (const member of rawMembers) {
      if (typeof member !== "string" || !member) {
        return {
          kind: "unavailable",
          channelId,
          reason: "malformed_response",
          slackErrorCode: undefined,
        };
      }
      memberIds.push(member);
    }
    pages += 1;

    const nextCursor =
      typeof page.response_metadata?.next_cursor === "string"
        ? page.response_metadata.next_cursor.trim()
        : "";
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      return {
        kind: "unavailable",
        channelId,
        reason: "pagination_loop",
        slackErrorCode: "repeated_cursor",
      };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return {
    kind: "snapshot",
    channelId,
    memberIds,
    completedPages: pages,
    observedAt: new Date().toISOString(),
  };
}
