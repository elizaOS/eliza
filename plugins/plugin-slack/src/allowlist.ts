/**
 * Per-channel config resolution and inbound gating for the Slack connector.
 *
 * `SlackConfigSchema` (packages/agent/src/config/zod-schema.providers-core.ts)
 * has long parsed `channels.slack.channels[<id>]` entries carrying
 * `enabled` / `allow` / `requireMention` / `users` (plus `skills` and
 * `systemPrompt`), but `SlackService` only ever honoured the global
 * `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` env flag and the `SLACK_CHANNEL_IDS`
 * allowlist. Config that looked applied was silently dropped.
 *
 * This module ports the resolution pattern from `plugins/plugin-discord/allowlist.ts`
 * to Slack: it turns the structured per-channel record into (a) an allowlist
 * source and (b) an effective `requireMention` / user-allowlist decision, with
 * the precedence
 *
 *     per-channel explicit  >  account-level explicit  >  global env  >  default
 *
 * Matching is id-first (`C0123ABCD`), then by normalized channel-name slug when
 * the name is already known to the caller (the service passes its channel cache
 * entry, so gating never triggers an extra Slack API call), then `"*"`.
 */
import type { SlackChannelConfig } from "./accounts";

/**
 * Normalized allowlist structure for Slack entities (users, channels).
 */
export interface SlackAllowList {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
}

/**
 * How a channel config entry was matched.
 */
export type SlackChannelMatchSource = "id" | "name" | "wildcard";

/**
 * A per-channel config entry resolved against a concrete channel.
 */
export interface SlackChannelConfigResolved {
  /** False only when the entry explicitly sets `enabled: false` / `allow: false`. */
  allowed: boolean;
  /** Explicit per-channel mention requirement, when the entry sets one. */
  requireMention?: boolean;
  /** Explicit per-channel user allowlist, when the entry sets one. */
  users?: Array<string | number>;
  /** Explicit per-channel bot-message toggle, when the entry sets one. */
  allowBots?: boolean;
  /**
   * Resolved but NOT yet consumed by the service. Per-channel skill filtering
   * and system-prompt injection require changes to how message context is
   * assembled and are deliberately out of scope here; they are surfaced so the
   * follow-up slice has a single resolution point rather than a second one.
   */
  skills?: string[];
  /** Resolved but NOT yet consumed by the service. See `skills`. */
  systemPrompt?: string;
  /** The config key that matched (`C0123ABCD`, a name slug, or `"*"`). */
  matchKey?: string;
  matchSource?: SlackChannelMatchSource;
}

/**
 * Normalizes a Slack name into a comparable slug.
 *
 * Slack channel names are already lowercase and dash-separated, but config is
 * hand-written, so `#General Chat` and `general-chat` must compare equal.
 */
export function normalizeSlackSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * True when the string looks like a Slack channel id (`C`/`G`/`D` + base32-ish).
 *
 * Used to decide whether a `channels` config key is an id (usable as an
 * allowlist entry on its own) or a human-written channel name (which can only
 * be matched once the name is known).
 */
export function isSlackChannelIdKey(key: string): boolean {
  return /^[CGD][A-Z0-9]{8,}$/i.test(key.trim());
}

/**
 * True when the string looks like a Slack user id (`U`, or `W` on Enterprise Grid).
 */
function isSlackUserIdLike(value: string): boolean {
  return /^[UW][A-Z0-9]{8,}$/i.test(value);
}

/**
 * Normalizes a raw allowlist array into a structured {@link SlackAllowList}.
 *
 * Accepts bare ids (`U0123ABCD`), Slack mention syntax (`<@U0123ABCD>`),
 * prefixed ids (`slack:U0123ABCD`, `user:…`), `"*"` for allow-all, and plain
 * names/handles, which are compared as slugs.
 *
 * Returns `null` for an absent or empty list, which callers read as
 * "no allowlist configured" (i.e. allow) rather than "allowlist matching nothing".
 */
export function normalizeSlackAllowList(
  raw: Array<string | number> | undefined,
  prefixes: string[] = ["slack:", "user:", "pk:"],
): SlackAllowList | null {
  if (!raw || raw.length === 0) {
    return null;
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  const allowAll = raw.some((entry) => String(entry).trim() === "*");

  for (const entry of raw) {
    const text = String(entry).trim();
    if (!text || text === "*") {
      continue;
    }

    // Slack mention syntax: <@U0123ABCD> / <@U0123ABCD|display-name>
    const mention = text.replace(/^<@/, "").replace(/>$/, "").split("|")[0];
    if (mention && isSlackUserIdLike(mention)) {
      ids.add(mention.toUpperCase());
      continue;
    }

    const prefix = prefixes.find((p) => text.toLowerCase().startsWith(p));
    if (prefix) {
      const candidate = text.slice(prefix.length).trim();
      if (candidate) {
        // A prefixed value is an id if it looks like one, otherwise a handle.
        if (isSlackUserIdLike(candidate)) {
          ids.add(candidate.toUpperCase());
        } else {
          const slug = normalizeSlackSlug(candidate);
          if (slug) names.add(slug);
        }
      }
      continue;
    }

    const slug = normalizeSlackSlug(text);
    if (slug) {
      names.add(slug);
    }
  }

  return { allowAll, ids, names };
}

/**
 * Checks a candidate (id and/or display name/handle) against a normalized list.
 */
export function slackAllowListMatches(
  list: SlackAllowList,
  candidate: { id?: string; name?: string; handle?: string },
): boolean {
  if (list.allowAll) {
    return true;
  }

  if (candidate.id && list.ids.has(candidate.id.toUpperCase())) {
    return true;
  }

  for (const value of [candidate.name, candidate.handle]) {
    if (!value) continue;
    const slug = normalizeSlackSlug(value);
    if (slug && list.names.has(slug)) {
      return true;
    }
  }

  return false;
}

/**
 * Whether a Slack user passes an allowlist. An unset/empty allowlist allows.
 */
export function resolveSlackUserAllowed(params: {
  allowList?: Array<string | number>;
  userId?: string;
  userName?: string;
  userHandle?: string;
}): boolean {
  const list = normalizeSlackAllowList(params.allowList);
  if (!list) {
    return true;
  }

  return slackAllowListMatches(list, {
    id: params.userId,
    name: params.userName,
    handle: params.userHandle,
  });
}

/**
 * Resolves the `channels` config entry that applies to a concrete channel.
 *
 * Returns `null` when no `channels` record is configured at all, which callers
 * must distinguish from "configured, but this channel has no entry" (an
 * unmatched channel yields `null` too, so the caller keeps its existing
 * env-driven behaviour rather than inventing a deny).
 */
export function resolveSlackChannelConfig(params: {
  channels?: Record<string, SlackChannelConfig | undefined>;
  channelId: string;
  channelName?: string;
}): SlackChannelConfigResolved | null {
  const { channels, channelId, channelName } = params;
  if (!channels || typeof channels !== "object") {
    return null;
  }

  const match = resolveSlackChannelEntry(channels, channelId, channelName);
  if (!match) {
    return null;
  }

  const { entry, matchKey, matchSource } = match;

  return {
    // `enabled` is the documented key; `allow` is the legacy alias. Either
    // one set to false disables the channel.
    allowed: entry.enabled !== false && entry.allow !== false,
    requireMention: entry.requireMention,
    users: entry.users,
    allowBots: entry.allowBots,
    skills: entry.skills,
    systemPrompt: entry.systemPrompt,
    matchKey,
    matchSource,
  };
}

function resolveSlackChannelEntry(
  channels: Record<string, SlackChannelConfig | undefined>,
  channelId: string,
  channelName?: string,
): {
  entry: SlackChannelConfig;
  matchKey: string;
  matchSource: SlackChannelMatchSource;
} | null {
  // 1. Exact channel id (case-insensitive; Slack ids are uppercase).
  for (const [key, entry] of Object.entries(channels)) {
    if (!entry) continue;
    if (key.trim().toUpperCase() === channelId.trim().toUpperCase()) {
      return { entry, matchKey: key, matchSource: "id" };
    }
  }

  // 2. Channel-name slug, only when the caller already knows the name.
  //    Never fetched here: gating must not add a Slack API round-trip per
  //    inbound message.
  const nameSlug = channelName ? normalizeSlackSlug(channelName) : "";
  if (nameSlug) {
    for (const [key, entry] of Object.entries(channels)) {
      if (!entry) continue;
      if (isSlackChannelIdKey(key)) continue;
      if (normalizeSlackSlug(key) === nameSlug) {
        return { entry, matchKey: key, matchSource: "name" };
      }
    }
  }

  // 3. Wildcard default.
  const wildcard = channels["*"];
  if (wildcard) {
    return { entry: wildcard, matchKey: "*", matchSource: "wildcard" };
  }

  return null;
}

/**
 * Collects the channel ids that a structured `channels` record contributes to
 * the inbound allowlist.
 *
 * Only id-shaped keys can act as an allowlist source: a name-keyed entry cannot
 * be turned into an id without an API call, so it participates in per-channel
 * resolution (once the name is cached) but never widens the allowlist. Entries
 * explicitly disabled are excluded — they are denials, not admissions.
 */
export function collectSlackConfiguredChannelIds(
  channels?: Record<string, SlackChannelConfig | undefined>,
): string[] {
  if (!channels || typeof channels !== "object") {
    return [];
  }

  const ids: string[] = [];
  for (const [key, entry] of Object.entries(channels)) {
    if (!entry) continue;
    if (entry.enabled === false || entry.allow === false) continue;
    const trimmed = key.trim();
    if (isSlackChannelIdKey(trimmed)) {
      ids.push(trimmed);
    }
  }
  return ids;
}

/**
 * Resolves whether the bot must be mentioned to respond in this channel.
 *
 * Precedence, highest first:
 *   1. per-channel `channels.<id>.requireMention`
 *   2. account-level `requireMention`
 *   3. global env `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS`
 *   4. false (historical default: respond to everything in allowed channels)
 *
 * Note the default stays `false` rather than following the zod schema's
 * documented `true`: flipping it would silence every existing env-only
 * deployment that never set the flag. Making `true` the default is a separate,
 * announced change.
 */
export function resolveSlackShouldRequireMention(params: {
  channelConfig?: SlackChannelConfigResolved | null;
  accountRequireMention?: boolean;
  globalRequireMention?: boolean;
}): boolean {
  return (
    params.channelConfig?.requireMention ??
    params.accountRequireMention ??
    params.globalRequireMention ??
    false
  );
}

/** Why an inbound Slack message was dropped. */
export type SlackInboundDenyReason =
  | "channel_disabled"
  | "channel_not_allowed"
  | "user_not_allowed"
  | "mention_required";

/**
 * Single decision point for inbound gating, shared by the `message` and
 * `app_mention` handlers so the two paths cannot drift.
 *
 * `isChannelAllowed` is supplied by the caller (it folds the env allowlist,
 * the structured channel ids, and dynamically joined channels); this function
 * layers the per-channel config on top of it.
 */
export function resolveSlackInboundGate(params: {
  channelConfig?: SlackChannelConfigResolved | null;
  isChannelAllowed: boolean;
  isMentioned: boolean;
  /** app_mention events are mentions by definition. */
  skipMentionCheck?: boolean;
  accountRequireMention?: boolean;
  globalRequireMention?: boolean;
  userId?: string;
  userName?: string;
  userHandle?: string;
}): { allowed: boolean; reason?: SlackInboundDenyReason } {
  const { channelConfig } = params;

  // An explicit per-channel disable outranks every admission source, including
  // a dynamic join and the env allowlist. Otherwise `enabled: false` would be
  // unenforceable in any channel the bot is a member of.
  if (channelConfig && !channelConfig.allowed) {
    return { allowed: false, reason: "channel_disabled" };
  }

  if (!params.isChannelAllowed) {
    return { allowed: false, reason: "channel_not_allowed" };
  }

  if (channelConfig?.users) {
    const userAllowed = resolveSlackUserAllowed({
      allowList: channelConfig.users,
      userId: params.userId,
      userName: params.userName,
      userHandle: params.userHandle,
    });
    if (!userAllowed) {
      return { allowed: false, reason: "user_not_allowed" };
    }
  }

  if (!params.skipMentionCheck) {
    const requireMention = resolveSlackShouldRequireMention({
      channelConfig,
      accountRequireMention: params.accountRequireMention,
      globalRequireMention: params.globalRequireMention,
    });
    if (requireMention && !params.isMentioned) {
      return { allowed: false, reason: "mention_required" };
    }
  }

  return { allowed: true };
}
