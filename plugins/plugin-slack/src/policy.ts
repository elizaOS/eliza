/**
 * The single authoritative inbound policy model for the Slack connector.
 *
 * `SlackConfigSchema` (packages/agent/src/config/zod-schema.providers-core.ts)
 * has long accepted a rich policy surface — per-channel `enabled` /
 * `requireMention` / `users` / `allowBots`, an account `groupPolicy`, and a
 * `dm` block with `policy` / `allowFrom` / `groupEnabled` / `groupChannels` —
 * while `SlackService` gated purely on the global
 * `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` env flag and the `SLACK_CHANNEL_IDS`
 * allowlist. Config that looked applied was silently dropped: the worst
 * possible failure mode for an authorization boundary.
 *
 * This module owns the whole decision, for every event class, in one place:
 *
 *   1. `assertSlackPolicySupported()` — refuses, at configuration time, any
 *      policy key the service cannot honor. Silently accepting a policy is the
 *      root bug; a loud failure is the fix.
 *   2. `resolveSlackAccountPolicy()` — runs ONCE per account at startup and
 *      converts every human-written name/handle into an immutable Slack ID.
 *      Authorization at event time therefore never depends on a warm cache, a
 *      name lookup, or an API round trip. Ambiguous or unresolvable entries
 *      that carry restrictive intent fail startup rather than degrade to
 *      allow-all.
 *   3. `classifySlackEvent()` — explicitly separates `im`, `app_home`, `mpim`,
 *      `channel` and private-channel (`group`) traffic, because Slack delivers
 *      Messages-tab (App Home) traffic on `D` channels and MPIMs through the
 *      same `message` event as public channels.
 *   4. `evaluateSlackInbound()` — the one gate both the `message` and
 *      `app_mention` handlers call, so the two paths cannot drift.
 *
 * Slack explicitly advises against inferring meaning from ID prefixes or
 * character sets (https://api.slack.com/changelog/2016-08-11-user-id-format-changes),
 * so prefix shapes are used ONLY to decide whether a config key is worth
 * treating as a literal opaque ID; every authorization comparison is an exact
 * opaque-string match against an ID the Slack API returned.
 */
import type {
  ResolvedSlackAccount,
  SlackChannelConfig,
  SlackDmConfig,
} from "./accounts";

/**
 * Thrown when configuration cannot be honored. Startup must not continue: an
 * operator who wrote a policy is entitled to have it enforced or to be told,
 * loudly, that it is not.
 */
export class SlackPolicyError extends Error {
  constructor(
    message: string,
    readonly accountId: string,
  ) {
    super(message);
    this.name = "SlackPolicyError";
  }
}

/**
 * Slack event classes that carry inbound user text. Each one has its own
 * policy: DM policy for `im`/`app_home`, DM *group* policy for `mpim`, and
 * channel policy for `channel`/`group`.
 */
export type SlackEventClass =
  | "im"
  | "app_home"
  | "mpim"
  | "channel"
  | "group"
  | "unknown";

/** True for the surfaces a human experiences as "a DM with the app". */
export function isSlackDirectSurface(eventClass: SlackEventClass): boolean {
  return eventClass === "im" || eventClass === "app_home";
}

/**
 * Classifies a raw inbound Slack event.
 *
 * `channel_type` is authoritative when Slack sends it: `im` for classic DMs,
 * `app_home` for Messages-tab traffic (which arrives on a `D` channel id and
 * would otherwise be mistaken for a normal channel and matched against
 * `channels["*"]`), `mpim` for group DMs, `group` for private channels and
 * `channel` for public ones.
 *
 * Only when `channel_type` is absent do we fall back to the id prefix, and an
 * event we cannot classify is reported as `unknown` so the gate can fail
 * closed instead of guessing.
 */
export function classifySlackEvent(input: {
  channelType?: string | null;
  channelId?: string | null;
  eventType?: string | null;
  subtype?: string | null;
}): SlackEventClass {
  const type = input.channelType?.trim().toLowerCase();
  switch (type) {
    case "im":
      return "im";
    case "app_home":
      return "app_home";
    case "mpim":
      return "mpim";
    case "group":
      return "group";
    case "channel":
      return "channel";
    default:
      break;
  }

  // Slack also identifies App Home traffic through the event name itself
  // (`message.app_home`) rather than only through `channel_type`.
  const eventName = `${input.eventType ?? ""}.${input.subtype ?? ""}`
    .trim()
    .toLowerCase();
  if (eventName.includes("app_home")) {
    return "app_home";
  }

  const channelId = input.channelId?.trim().toUpperCase() ?? "";
  if (channelId.startsWith("D")) {
    // A D-channel is a direct surface. Without `channel_type` we cannot tell a
    // Messages-tab post from a classic DM, but both are governed by DM policy,
    // so the distinction does not change the decision.
    return "im";
  }
  if (channelId.startsWith("G")) {
    return "group";
  }
  if (channelId.startsWith("C")) {
    return "channel";
  }
  return "unknown";
}

/**
 * A per-channel policy after startup resolution. Every identifier here is an
 * immutable Slack ID; nothing in this structure requires a name lookup.
 */
export interface SlackChannelPolicy {
  /** False only when the entry explicitly set `enabled:false` / `allow:false`. */
  enabled: boolean;
  requireMention?: boolean;
  allowBots?: boolean;
  /**
   * `null` means the entry declared no user policy (everyone allowed).
   * A set — including an EMPTY one, which `users: []` produces — means the
   * entry declared a policy and only listed senders pass.
   */
  allowedUserIds: Set<string> | null;
  /** True when the user list contained `"*"`. */
  allowAllUsers: boolean;
  /** The config key this entry came from, for logs. */
  sourceKey: string;
}

/** DM policy after startup resolution. */
export interface SlackDmPolicy {
  /**
   * `legacy` is the state of a deployment that wrote no `dm` block at all: DMs
   * keep the historical always-allowed behaviour. Every other value came from
   * the operator (or from the schema default that applies once a `dm` block
   * exists) and is enforced.
   */
  policy: "legacy" | "open" | "allowlist" | "disabled" | "pairing";
  /** `dm.enabled:false` shuts DMs off regardless of policy. */
  enabled: boolean;
  allowAll: boolean;
  allowedUserIds: Set<string>;
  /** `dm.groupEnabled`; undefined means "follow the DM policy". */
  groupEnabled?: boolean;
  /** `null` means no MPIM allowlist was declared. */
  groupChannelIds: Set<string> | null;
}

/** How the effective group policy was arrived at, for logging. */
export type SlackGroupPolicySource =
  | "explicit"
  | "implicit-allowlist"
  | "implicit-open";

/** The fully resolved, ID-only policy for one Slack account. */
export interface SlackResolvedPolicy {
  accountId: string;
  groupPolicy: "open" | "disabled" | "allowlist";
  groupPolicySource: SlackGroupPolicySource;
  /** Per-channel entries keyed by immutable channel ID. */
  channelsById: Map<string, SlackChannelPolicy>;
  /** The `"*"` entry, applied to channel/group traffic with no exact entry. */
  wildcard: SlackChannelPolicy | null;
  /** Static admissions: env `SLACK_CHANNEL_IDS` + resolved config channel IDs. */
  allowedChannelIds: Set<string>;
  dm: SlackDmPolicy;
  accountRequireMention?: boolean;
  accountAllowBots?: boolean;
  ignoreBotMessages: boolean;
  globalRequireMention: boolean;
  /** Non-fatal configuration notes the service logs once at startup. */
  warnings: string[];
}

/** Minimal Slack lookups the resolver needs to turn names into IDs. */
export interface SlackPolicyLookups {
  listChannels(): Promise<Array<{ id: string; name?: string }>>;
  listUsers(): Promise<
    Array<{
      id: string;
      name?: string;
      realName?: string;
      displayName?: string;
      deleted?: boolean;
    }>
  >;
}

/**
 * Normalizes a Slack name into a comparable slug so a hand-written
 * `#General Chat` matches the API's `general-chat`.
 */
export function normalizeSlackSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Whether a config key looks like a literal Slack channel ID.
 *
 * This is a routing hint only — it decides whether we treat the key as an
 * opaque identifier or as a human name that must be resolved through the API.
 * No authorization decision is derived from the shape itself.
 */
export function isSlackChannelIdKey(key: string): boolean {
  return /^[CGD][A-Z0-9]{8,}$/.test(key.trim().toUpperCase());
}

/** Whether a config value looks like a literal Slack user ID (`U`/`W`). */
export function isSlackUserIdKey(value: string): boolean {
  return /^[UW][A-Z0-9]{8,}$/.test(value.trim().toUpperCase());
}

/**
 * Strips the accepted decorations from a user allowlist entry: Slack mention
 * syntax (`<@U0123ABCD|name>`) and the `slack:` / `user:` prefixes.
 */
function stripUserEntryDecoration(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("<@") && text.endsWith(">")) {
    text = text.slice(2, -1).split("|")[0]?.trim() ?? "";
  }
  for (const prefix of ["slack:", "user:"]) {
    if (text.toLowerCase().startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }
  return text;
}

/**
 * Policy keys the schema accepts but this service does not implement.
 *
 * Split deliberately in two. `UNHONORED_SECURITY_KEYS` change who may do what,
 * so accepting them silently manufactures a gate that does not exist —
 * startup fails. The advisory keys only change presentation or convenience, so
 * they produce a loud startup warning listing exactly what is inert.
 */
const UNHONORED_ADVISORY_ACCOUNT_KEYS = [
  "slashCommand",
  "thread",
  "historyLimit",
  "dmHistoryLimit",
  "blockStreaming",
  "blockStreamingCoalesce",
  "chunkMode",
  "hb_signal",
  "dms",
] as const;

const UNHONORED_ADVISORY_CHANNEL_KEYS = ["skills", "systemPrompt"] as const;

/**
 * Rejects configuration this service cannot enforce.
 *
 * Throws for security-relevant policy (per-channel tool authorization, and the
 * HTTP/Events-API ingress the service never implemented — it hardcodes Socket
 * Mode, so an operator who configured `mode:"http"` believes their signing
 * secret is validating requests that in fact never arrive that way).
 */
export function assertSlackPolicySupported(
  account: ResolvedSlackAccount,
): void {
  const accountId = account.accountId;
  const config = account.config;

  if (config.mode && config.mode !== "socket") {
    throw new SlackPolicyError(
      `Slack account "${accountId}" sets mode="${config.mode}", but plugin-slack only implements Socket Mode. ` +
        `Remove the mode key (or set mode="socket") — leaving it would silently run a different ingress than configured.`,
      accountId,
    );
  }

  for (const [key, entry] of Object.entries(account.channels ?? {})) {
    if (!entry) continue;
    if (entry.tools !== undefined || entry.toolsBySender !== undefined) {
      throw new SlackPolicyError(
        `Slack account "${accountId}" channel "${key}" declares a tools/toolsBySender policy, ` +
          `but plugin-slack does not enforce per-channel tool authorization. ` +
          `Remove the key rather than relying on an unenforced authorization boundary.`,
        accountId,
      );
    }
  }

  const dmPolicy = account.dm?.policy;
  if (
    account.dm &&
    dmPolicy === "allowlist" &&
    (!account.dm.allowFrom || account.dm.allowFrom.length === 0)
  ) {
    throw new SlackPolicyError(
      `Slack account "${accountId}" sets dm.policy="allowlist" with no dm.allowFrom entries. ` +
        `That admits nobody; declare dm.allowFrom, or use dm.policy="disabled" to state the intent explicitly.`,
      accountId,
    );
  }
}

/** Collects the advisory (inert-config) warnings for one account. */
function collectAdvisoryWarnings(account: ResolvedSlackAccount): string[] {
  const warnings: string[] = [];
  const config = account.config as Record<string, unknown>;

  const inertAccountKeys = UNHONORED_ADVISORY_ACCOUNT_KEYS.filter(
    (key) => config[key] !== undefined,
  );
  if (inertAccountKeys.length > 0) {
    warnings.push(
      `Slack account "${account.accountId}": these configured keys are accepted by the schema but NOT implemented ` +
        `by plugin-slack and have no effect: ${inertAccountKeys.join(", ")}.`,
    );
  }

  for (const [key, entry] of Object.entries(account.channels ?? {})) {
    if (!entry) continue;
    const inertChannelKeys = UNHONORED_ADVISORY_CHANNEL_KEYS.filter(
      (channelKey) =>
        (entry as Record<string, unknown>)[channelKey] !== undefined,
    );
    if (inertChannelKeys.length > 0) {
      warnings.push(
        `Slack account "${account.accountId}" channel "${key}": ${inertChannelKeys.join(", ")} ` +
          `is accepted by the schema but not yet applied to message context; it has no effect today.`,
      );
    }
    if (Array.isArray(entry.users) && entry.users.length === 0) {
      warnings.push(
        `Slack account "${account.accountId}" channel "${key}": users:[] is an EMPTY allowlist and denies every ` +
          `sender in that channel. Remove the key to allow everyone.`,
      );
    }
  }

  return warnings;
}

/** Index of channel-name slug → the IDs carrying that name. */
type NameIndex = Map<string, string[]>;

async function buildChannelNameIndex(
  lookups: SlackPolicyLookups,
  accountId: string,
): Promise<NameIndex> {
  let channels: Array<{ id: string; name?: string }>;
  try {
    channels = await lookups.listChannels();
  } catch (error) {
    throw new SlackPolicyError(
      `Slack account "${accountId}" configures channels by name, but the channel list could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Grant channels:read/groups:read, or key the config by immutable channel ID.`,
      accountId,
    );
  }

  const index: NameIndex = new Map();
  for (const channel of channels) {
    const slug = channel.name ? normalizeSlackSlug(channel.name) : "";
    if (!slug || !channel.id) continue;
    const existing = index.get(slug);
    if (existing) existing.push(channel.id);
    else index.set(slug, [channel.id]);
  }
  return index;
}

interface UserIndexEntry {
  ids: string[];
  deleted: boolean;
}

async function buildUserNameIndex(
  lookups: SlackPolicyLookups,
  accountId: string,
): Promise<Map<string, UserIndexEntry>> {
  let users: Awaited<ReturnType<SlackPolicyLookups["listUsers"]>>;
  try {
    users = await lookups.listUsers();
  } catch (error) {
    throw new SlackPolicyError(
      `Slack account "${accountId}" configures a user allowlist by name/handle, but the user list could not be ` +
        `read (${error instanceof Error ? error.message : String(error)}). ` +
        `Grant users:read, or list users by immutable Slack ID.`,
      accountId,
    );
  }

  const index = new Map<string, UserIndexEntry>();
  const add = (value: string | undefined, id: string, deleted: boolean) => {
    const slug = value ? normalizeSlackSlug(value) : "";
    if (!slug) return;
    const existing = index.get(slug);
    if (existing) {
      if (!existing.ids.includes(id)) existing.ids.push(id);
      existing.deleted = existing.deleted && deleted;
    } else {
      index.set(slug, { ids: [id], deleted });
    }
  };

  for (const user of users) {
    if (!user.id) continue;
    add(user.name, user.id, Boolean(user.deleted));
    add(user.displayName, user.id, Boolean(user.deleted));
    add(user.realName, user.id, Boolean(user.deleted));
  }
  return index;
}

/** Whether a channel entry expresses restrictive intent. */
function isRestrictiveChannelEntry(entry: SlackChannelConfig): boolean {
  return (
    entry.enabled === false ||
    entry.allow === false ||
    entry.requireMention !== undefined ||
    entry.users !== undefined ||
    entry.allowBots !== undefined
  );
}

/**
 * Resolves every configured user reference to immutable account-scoped IDs.
 *
 * Names are resolved once, here, so the event-time gate compares opaque IDs
 * only. Ambiguity (one handle, several accounts) and unresolvable entries both
 * fail startup: an allowlist that quietly does not contain the person the
 * operator named is an authorization bug either way it falls.
 */
function resolveUserEntries(params: {
  raw: Array<string | number>;
  index: Map<string, UserIndexEntry> | null;
  accountId: string;
  label: string;
}): { ids: Set<string>; allowAll: boolean } {
  const ids = new Set<string>();
  let allowAll = false;

  for (const rawEntry of params.raw) {
    const text = String(rawEntry).trim();
    if (!text) continue;
    if (text === "*") {
      allowAll = true;
      continue;
    }

    const candidate = stripUserEntryDecoration(text);
    if (!candidate) continue;

    if (isSlackUserIdKey(candidate)) {
      ids.add(candidate.toUpperCase());
      continue;
    }

    const slug = normalizeSlackSlug(candidate);
    const match = params.index?.get(slug);
    if (!match) {
      throw new SlackPolicyError(
        `Slack account "${params.accountId}" ${params.label} lists "${text}", which does not resolve to any ` +
          `workspace user. Fix the entry or use the immutable Slack user ID — an allowlist that silently omits ` +
          `the named person is an authorization bug.`,
        params.accountId,
      );
    }
    if (match.ids.length > 1) {
      throw new SlackPolicyError(
        `Slack account "${params.accountId}" ${params.label} lists "${text}", which is ambiguous across ` +
          `${match.ids.length} users (${match.ids.join(", ")}). Use the immutable Slack user ID.`,
        params.accountId,
      );
    }
    if (match.deleted) {
      throw new SlackPolicyError(
        `Slack account "${params.accountId}" ${params.label} lists "${text}", which resolves to a deactivated ` +
          `user (${match.ids[0]}). Remove the entry: a name freed by deactivation can be reused by another account.`,
        params.accountId,
      );
    }
    ids.add(String(match.ids[0]).toUpperCase());
  }

  return { ids, allowAll };
}

function resolveDmPolicy(params: {
  dm: SlackDmConfig | undefined;
  userIndex: Map<string, UserIndexEntry> | null;
  channelIndex: NameIndex | null;
  accountId: string;
}): SlackDmPolicy {
  const { dm, accountId } = params;
  if (!dm) {
    // No `dm` block was written at all. The schema's `policy` default only
    // materializes once the object exists, so an untouched deployment keeps
    // the historical behaviour rather than silently losing its DMs.
    return {
      policy: "legacy",
      enabled: true,
      allowAll: true,
      allowedUserIds: new Set(),
      groupChannelIds: null,
    };
  }

  // `SlackDmSchema` defaults `policy` to "pairing" once a dm block exists.
  const policy = dm.policy ?? "pairing";
  const allowFrom = dm.allowFrom ?? [];
  const { ids, allowAll } = resolveUserEntries({
    raw: allowFrom,
    index: params.userIndex,
    accountId,
    label: "dm.allowFrom",
  });

  let groupChannelIds: Set<string> | null = null;
  if (dm.groupChannels) {
    groupChannelIds = new Set<string>();
    for (const rawEntry of dm.groupChannels) {
      const text = String(rawEntry).trim();
      if (!text) continue;
      if (isSlackChannelIdKey(text)) {
        groupChannelIds.add(text.toUpperCase());
        continue;
      }
      const slug = normalizeSlackSlug(text);
      const matches = params.channelIndex?.get(slug);
      if (!matches || matches.length === 0) {
        throw new SlackPolicyError(
          `Slack account "${accountId}" dm.groupChannels lists "${text}", which does not resolve to any ` +
            `conversation. Use the immutable channel ID.`,
          accountId,
        );
      }
      if (matches.length > 1) {
        throw new SlackPolicyError(
          `Slack account "${accountId}" dm.groupChannels lists "${text}", which is ambiguous across ` +
            `${matches.length} conversations (${matches.join(", ")}). Use the immutable channel ID.`,
          accountId,
        );
      }
      groupChannelIds.add(String(matches[0]).toUpperCase());
    }
  }

  return {
    policy,
    enabled: dm.enabled !== false,
    allowAll: policy === "open" || allowAll,
    allowedUserIds: ids,
    groupEnabled: dm.groupEnabled,
    groupChannelIds,
  };
}

function toChannelPolicy(params: {
  entry: SlackChannelConfig;
  sourceKey: string;
  userIndex: Map<string, UserIndexEntry> | null;
  accountId: string;
}): SlackChannelPolicy {
  const { entry, sourceKey, accountId } = params;
  let allowedUserIds: Set<string> | null = null;
  let allowAllUsers = false;

  if (entry.users !== undefined) {
    const resolved = resolveUserEntries({
      raw: entry.users,
      index: params.userIndex,
      accountId,
      label: `channel "${sourceKey}" users`,
    });
    allowedUserIds = resolved.ids;
    allowAllUsers = resolved.allowAll;
  }

  return {
    enabled: entry.enabled !== false && entry.allow !== false,
    requireMention: entry.requireMention,
    allowBots: entry.allowBots,
    allowedUserIds,
    allowAllUsers,
    sourceKey,
  };
}

/**
 * Determines whether the account's config needs the Slack API to resolve any
 * name. A pure-ID configuration costs zero startup API calls.
 */
function needsNameResolution(account: ResolvedSlackAccount): {
  channels: boolean;
  users: boolean;
} {
  let channels = false;
  let users = false;

  for (const [key, entry] of Object.entries(account.channels ?? {})) {
    if (!entry) continue;
    if (key !== "*" && !isSlackChannelIdKey(key)) channels = true;
    for (const raw of entry.users ?? []) {
      const text = stripUserEntryDecoration(String(raw));
      if (text && text !== "*" && !isSlackUserIdKey(text)) users = true;
    }
  }
  for (const raw of account.dm?.allowFrom ?? []) {
    const text = stripUserEntryDecoration(String(raw));
    if (text && text !== "*" && !isSlackUserIdKey(text)) users = true;
  }
  for (const raw of account.dm?.groupChannels ?? []) {
    const text = String(raw).trim();
    if (text && !isSlackChannelIdKey(text)) channels = true;
  }

  return { channels, users };
}

/**
 * Resolves an account's configuration into the immutable, ID-only policy the
 * gate evaluates. Runs once per account during `startAccount`, before any
 * event handler is registered, so no event can be evaluated against a
 * half-resolved policy.
 */
export async function resolveSlackAccountPolicy(params: {
  account: ResolvedSlackAccount;
  lookups: SlackPolicyLookups;
  envAllowedChannelIds?: string[];
  globalRequireMention?: boolean;
  ignoreBotMessages?: boolean;
}): Promise<SlackResolvedPolicy> {
  const { account } = params;
  const accountId = account.accountId;

  assertSlackPolicySupported(account);
  const warnings = collectAdvisoryWarnings(account);

  const needs = needsNameResolution(account);
  const channelIndex = needs.channels
    ? await buildChannelNameIndex(params.lookups, accountId)
    : null;
  const userIndex = needs.users
    ? await buildUserNameIndex(params.lookups, accountId)
    : null;

  const channelsById = new Map<string, SlackChannelPolicy>();
  let wildcard: SlackChannelPolicy | null = null;

  for (const [key, entry] of Object.entries(account.channels ?? {})) {
    if (!entry) continue;
    const trimmed = key.trim();
    if (!trimmed) continue;

    if (trimmed === "*") {
      wildcard = toChannelPolicy({
        entry,
        sourceKey: "*",
        userIndex,
        accountId,
      });
      continue;
    }

    if (isSlackChannelIdKey(trimmed)) {
      channelsById.set(
        trimmed.toUpperCase(),
        toChannelPolicy({ entry, sourceKey: trimmed, userIndex, accountId }),
      );
      continue;
    }

    // Name key: resolve to an immutable ID now, or fail. A name that reaches
    // the event-time gate can only be matched against a warm cache, and a cold
    // cache would let the first event through — exactly the bypass this
    // startup resolution removes.
    const slug = normalizeSlackSlug(trimmed);
    const matches = channelIndex?.get(slug) ?? [];
    if (matches.length > 1) {
      throw new SlackPolicyError(
        `Slack account "${accountId}" channel key "${trimmed}" is ambiguous across ${matches.length} ` +
          `conversations (${matches.join(", ")}). Key the config by immutable channel ID.`,
        accountId,
      );
    }
    if (matches.length === 0) {
      if (isRestrictiveChannelEntry(entry)) {
        throw new SlackPolicyError(
          `Slack account "${accountId}" channel key "${trimmed}" carries a restriction ` +
            `(enabled/allow/requireMention/users/allowBots) but does not resolve to any conversation the bot can ` +
            `see. A restriction that cannot be bound to a channel would silently not apply.`,
          accountId,
        );
      }
      warnings.push(
        `Slack account "${accountId}": channel key "${trimmed}" does not resolve to any visible conversation and ` +
          `declares no restriction; ignoring it.`,
      );
      continue;
    }

    channelsById.set(
      String(matches[0]).toUpperCase(),
      toChannelPolicy({ entry, sourceKey: trimmed, userIndex, accountId }),
    );
  }

  const allowedChannelIds = new Set<string>();
  for (const id of params.envAllowedChannelIds ?? []) {
    const trimmed = id.trim().toUpperCase();
    if (trimmed && isSlackChannelIdKey(trimmed)) allowedChannelIds.add(trimmed);
  }
  for (const [id, policy] of channelsById) {
    // A disabled entry is a denial, not an admission.
    if (policy.enabled) allowedChannelIds.add(id);
  }

  const dm = resolveDmPolicy({
    dm: account.dm,
    userIndex,
    channelIndex,
    accountId,
  });

  // Group policy. The schema documents `allowlist` as the default, and that is
  // the only sane reading once an operator has listed channels. But a legacy
  // env-only deployment never listed anything, and silently denying every
  // channel it currently serves would be a worse failure than the one being
  // fixed — so an unwritten policy with no allowlist source resolves to `open`
  // and says so in the startup log.
  const explicitGroupPolicy = account.config.groupPolicy;
  const hasAllowlistSource =
    allowedChannelIds.size > 0 || wildcard !== null || channelsById.size > 0;
  let groupPolicy: "open" | "disabled" | "allowlist";
  let groupPolicySource: SlackGroupPolicySource;
  if (explicitGroupPolicy) {
    groupPolicy = explicitGroupPolicy;
    groupPolicySource = "explicit";
  } else if (hasAllowlistSource) {
    groupPolicy = "allowlist";
    groupPolicySource = "implicit-allowlist";
  } else {
    groupPolicy = "open";
    groupPolicySource = "implicit-open";
  }

  if (
    groupPolicy === "allowlist" &&
    allowedChannelIds.size === 0 &&
    wildcard === null
  ) {
    throw new SlackPolicyError(
      `Slack account "${accountId}" resolves to groupPolicy="allowlist" with an empty allowlist, which admits no ` +
        `channel at all. List channels under channels.<id>, set SLACK_CHANNEL_IDS, add a "*" entry, or set ` +
        `groupPolicy="open"/"disabled" to state the intent.`,
      accountId,
    );
  }

  if (dm.policy === "pairing") {
    warnings.push(
      `Slack account "${accountId}": dm.policy="pairing" is not implemented by plugin-slack, so DMs FAIL CLOSED ` +
        `(all direct messages are dropped). Set dm.policy="open" with dm.allowFrom:["*"], or dm.policy="allowlist" ` +
        `with explicit dm.allowFrom entries.`,
    );
  }

  return {
    accountId,
    groupPolicy,
    groupPolicySource,
    channelsById,
    wildcard,
    allowedChannelIds,
    dm,
    accountRequireMention: account.requireMention,
    accountAllowBots: account.config.allowBots,
    ignoreBotMessages: params.ignoreBotMessages ?? false,
    globalRequireMention: params.globalRequireMention ?? false,
    warnings,
  };
}

/** Why an inbound Slack event was dropped. */
export type SlackInboundDenyReason =
  | "unclassified_event"
  | "bot_message"
  | "channel_disabled"
  | "channel_not_allowed"
  | "group_policy_disabled"
  | "dm_disabled"
  | "dm_policy_pairing"
  | "dm_not_allowed"
  | "mpim_disabled"
  | "mpim_not_allowed"
  | "user_not_allowed"
  | "mention_required";

export interface SlackInboundContext {
  eventClass: SlackEventClass;
  channelId: string;
  /** Opaque Slack user ID of the sender, when Slack supplied one. */
  userId?: string;
  isBotMessage: boolean;
  isMentioned: boolean;
  /** True for `app_mention` events, which are mentions by definition. */
  isAppMention: boolean;
  /** Channels the bot joined at runtime; admitted only under groupPolicy "open". */
  dynamicChannelIds?: Set<string>;
}

export interface SlackInboundDecision {
  allowed: boolean;
  reason?: SlackInboundDenyReason;
  /** The channel entry that decided the outcome, for logs. */
  matchedKey?: string;
}

function resolveChannelEntry(
  policy: SlackResolvedPolicy,
  channelId: string,
): SlackChannelPolicy | null {
  return (
    policy.channelsById.get(channelId.trim().toUpperCase()) ??
    policy.wildcard ??
    null
  );
}

function evaluateUserAllowance(
  entry: SlackChannelPolicy | null,
  userId?: string,
): boolean {
  if (!entry || entry.allowedUserIds === null) return true;
  if (entry.allowAllUsers) return true;
  if (!userId) return false;
  return entry.allowedUserIds.has(userId.trim().toUpperCase());
}

function evaluateBotAllowance(
  policy: SlackResolvedPolicy,
  entry: SlackChannelPolicy | null,
): boolean {
  const explicit = entry?.allowBots ?? policy.accountAllowBots;
  if (explicit !== undefined) return explicit;
  return !policy.ignoreBotMessages;
}

/**
 * The single inbound gate. Both the `message` and `app_mention` handlers call
 * this, with the event class the raw payload was classified into, so DM,
 * App Home, MPIM and channel traffic each get the policy that governs them.
 */
export function evaluateSlackInbound(
  policy: SlackResolvedPolicy,
  ctx: SlackInboundContext,
): SlackInboundDecision {
  if (ctx.eventClass === "unknown") {
    return { allowed: false, reason: "unclassified_event" };
  }

  // ---- Direct surfaces: classic DMs and the App Home Messages tab. -------
  if (isSlackDirectSurface(ctx.eventClass)) {
    if (ctx.isBotMessage && policy.ignoreBotMessages) {
      return { allowed: false, reason: "bot_message" };
    }
    const dm = policy.dm;
    if (!dm.enabled) return { allowed: false, reason: "dm_disabled" };
    switch (dm.policy) {
      case "legacy":
      case "open":
        return { allowed: true, matchedKey: "dm" };
      case "disabled":
        return { allowed: false, reason: "dm_disabled" };
      case "pairing":
        // Pairing requires an owner-pairing handshake this connector does not
        // implement. Failing closed is the only honest option; startup logs it.
        return { allowed: false, reason: "dm_policy_pairing" };
      case "allowlist": {
        if (dm.allowAll) return { allowed: true, matchedKey: "dm" };
        if (ctx.userId && dm.allowedUserIds.has(ctx.userId.toUpperCase())) {
          return { allowed: true, matchedKey: "dm" };
        }
        return { allowed: false, reason: "dm_not_allowed" };
      }
    }
  }

  // ---- Multi-person DMs: governed by the DM group policy, never by the ---
  // ---- channel wildcard. ------------------------------------------------
  if (ctx.eventClass === "mpim") {
    if (ctx.isBotMessage && policy.ignoreBotMessages) {
      return { allowed: false, reason: "bot_message" };
    }
    const dm = policy.dm;
    if (!dm.enabled) return { allowed: false, reason: "mpim_disabled" };
    if (dm.groupEnabled === false) {
      return { allowed: false, reason: "mpim_disabled" };
    }
    if (dm.groupChannelIds) {
      return dm.groupChannelIds.has(ctx.channelId.toUpperCase())
        ? { allowed: true, matchedKey: "dm.groupChannels" }
        : { allowed: false, reason: "mpim_not_allowed" };
    }
    if (dm.groupEnabled === true) {
      return { allowed: true, matchedKey: "dm.groupEnabled" };
    }
    // No explicit MPIM policy: follow the DM policy for the sender.
    switch (dm.policy) {
      case "legacy":
      case "open":
        return { allowed: true, matchedKey: "dm" };
      case "disabled":
        return { allowed: false, reason: "mpim_disabled" };
      case "pairing":
        return { allowed: false, reason: "dm_policy_pairing" };
      case "allowlist":
        if (dm.allowAll) return { allowed: true, matchedKey: "dm" };
        return ctx.userId && dm.allowedUserIds.has(ctx.userId.toUpperCase())
          ? { allowed: true, matchedKey: "dm" }
          : { allowed: false, reason: "dm_not_allowed" };
    }
  }

  // ---- Public channels and private channels (groups). -------------------
  const entry = resolveChannelEntry(policy, ctx.channelId);

  if (ctx.isBotMessage && !evaluateBotAllowance(policy, entry)) {
    return { allowed: false, reason: "bot_message" };
  }

  // An explicit per-channel disable outranks every admission source, including
  // a dynamic join and the env allowlist.
  if (entry && !entry.enabled) {
    return {
      allowed: false,
      reason: "channel_disabled",
      matchedKey: entry.sourceKey,
    };
  }

  if (policy.groupPolicy === "disabled") {
    return { allowed: false, reason: "group_policy_disabled" };
  }

  if (policy.groupPolicy === "allowlist") {
    const channelId = ctx.channelId.trim().toUpperCase();
    const admitted =
      policy.allowedChannelIds.has(channelId) || policy.wildcard !== null;
    if (!admitted) {
      // Dynamic joins do NOT widen an allowlist; under "open" they are
      // irrelevant because everything is admitted anyway.
      return { allowed: false, reason: "channel_not_allowed" };
    }
  }

  if (!evaluateUserAllowance(entry, ctx.userId)) {
    return {
      allowed: false,
      reason: "user_not_allowed",
      matchedKey: entry?.sourceKey,
    };
  }

  if (!ctx.isAppMention) {
    const requireMention =
      entry?.requireMention ??
      policy.accountRequireMention ??
      policy.globalRequireMention;
    if (requireMention && !ctx.isMentioned) {
      return {
        allowed: false,
        reason: "mention_required",
        matchedKey: entry?.sourceKey,
      };
    }
  }

  return { allowed: true, matchedKey: entry?.sourceKey };
}

/**
 * Whether a channel the bot just joined may be admitted at runtime.
 *
 * Under `allowlist` (the schema default once channels are configured) a join
 * must NOT widen admission, or any workspace member could add the bot to a
 * channel and bypass the allowlist outright.
 */
export function shouldAdmitDynamicJoin(policy: SlackResolvedPolicy): boolean {
  return policy.groupPolicy === "open";
}
