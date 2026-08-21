/**
 * Compiles one Slack account's persisted authorization settings into immutable
 * channel and user identifiers, then classifies and authorizes every inbound
 * event. Name-based policy is resolved before Bolt starts so a cold
 * cache, rename, duplicate display name, or dynamic join cannot widen access.
 */
import { ElizaError } from "@elizaos/core";
import type { ResolvedSlackAccount, SlackChannelConfig } from "./accounts";

export type SlackConversationKind =
  | "public_channel"
  | "private_channel"
  | "direct_message"
  | "app_home"
  | "multi_party_direct_message";

export type SlackInboundDenyReason =
  | "bot_not_allowed"
  | "channel_disabled"
  | "channel_not_allowed"
  | "dm_disabled"
  | "dm_user_not_allowed"
  | "group_dm_disabled"
  | "group_dm_not_allowed"
  | "mention_required"
  | "pairing_required"
  | "reaction_disabled"
  | "reaction_not_allowed"
  | "reaction_not_owned"
  | "user_not_allowed"
  | "unknown_conversation"
  | "workspace_identity_missing"
  | "workspace_identity_mismatch";

export interface SlackWorkspaceIdentity {
  teamId: string;
  botUserId: string;
  enterpriseId?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Extracts the authenticated installation identity from a Bolt event body. */
export function extractSlackEventWorkspace(body: unknown): {
  teamId?: string;
  enterpriseId?: string;
} {
  const root = readRecord(body);
  if (!root) return {};
  const event = readRecord(root.event);
  const authorization = Array.isArray(root.authorizations)
    ? readRecord(root.authorizations[0])
    : undefined;
  const teamId =
    readNonEmptyString(root.team_id) ??
    readNonEmptyString(authorization?.team_id) ??
    readNonEmptyString(event?.team_id) ??
    readNonEmptyString(event?.team);
  const enterpriseId =
    readNonEmptyString(root.enterprise_id) ??
    readNonEmptyString(authorization?.enterprise_id);
  return {
    ...(teamId ? { teamId } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
  };
}

export interface SlackInboundEventContext {
  eventType: "message" | "app_mention" | "reaction";
  channelId: string;
  userId: string;
  channelType?: string;
  subtype?: string;
  isThread: boolean;
  isMentioned: boolean;
  isBotMessage: boolean;
  teamId?: string;
  enterpriseId?: string;
}

export interface SlackInboundPolicyDecision {
  allowed: boolean;
  reason?: SlackInboundDenyReason;
  conversationKind?: SlackConversationKind;
  isThread: boolean;
  channelPolicyKey?: string;
  pairingReply?: string;
}

export interface SlackPairingDecision {
  allowed: boolean;
  replyMessage?: string;
}

export interface SlackPolicyDirectoryClient {
  conversations: {
    list(args: {
      cursor?: string;
      limit: number;
      types: string;
      exclude_archived: boolean;
    }): Promise<{
      channels?: SlackDirectoryChannel[];
      response_metadata?: { next_cursor?: string };
    }>;
    info(args: { channel: string }): Promise<{
      channel?: SlackDirectoryChannel;
    }>;
  };
  users: {
    list(args: { cursor?: string; limit: number }): Promise<{
      members?: SlackDirectoryUser[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

interface SlackDirectoryChannel {
  id?: string;
  name?: string;
  name_normalized?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}

interface SlackDirectoryUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  profile?: {
    display_name?: string;
    display_name_normalized?: string;
    real_name?: string;
    real_name_normalized?: string;
  };
}

interface CompiledIdentitySet {
  allowAll: boolean;
  ids: ReadonlySet<string>;
}

interface CompiledChannelPolicy {
  key: string;
  allowed: boolean;
  requireMention?: boolean;
  allowBots?: boolean;
  users?: CompiledIdentitySet;
}

interface CompiledDmPolicy {
  enabled: boolean;
  policy: "open" | "disabled" | "allowlist" | "pairing";
  users?: CompiledIdentitySet;
  groupEnabled: boolean;
  groupChannels?: ReadonlySet<string>;
}

export class SlackPolicyConfigurationError extends ElizaError {
  override readonly name = "SlackPolicyConfigurationError";

  constructor(
    message: string,
    public readonly accountId: string,
  ) {
    super(`Slack account ${accountId}: ${message}`, {
      code: "SLACK_POLICY_CONFIGURATION_INVALID",
      context: { accountId },
    });
  }
}

export interface SlackAccountPolicyResolverOptions {
  account: ResolvedSlackAccount;
  client: SlackPolicyDirectoryClient;
  workspace: SlackWorkspaceIdentity;
  checkPairing: (userId: string) => Promise<SlackPairingDecision>;
  cache?: {
    maxConversationKinds?: number;
    conversationKindTtlMs?: number;
    maxDynamicChannels?: number;
    now?: () => number;
  };
}

interface TimedValue<T> {
  value: T;
  expiresAt: number;
}

class BoundedTtlCache<K, V> {
  private readonly entries = new Map<K, TimedValue<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/**
 * Account-scoped authority for Slack event classification and admission.
 */
export class SlackAccountPolicyResolver {
  private readonly accountId: string;
  private readonly client: SlackPolicyDirectoryClient;
  private readonly workspace: SlackWorkspaceIdentity;
  private readonly checkPairing: (
    userId: string,
  ) => Promise<SlackPairingDecision>;
  private readonly structured: boolean;
  private readonly groupPolicy: "legacy" | "open" | "disabled" | "allowlist";
  private readonly requireMention: boolean;
  private readonly allowBots: boolean;
  private readonly reactionMode: "off" | "own" | "all" | "allowlist";
  private readonly reactionAllowlist: ReadonlySet<string>;
  private readonly staticChannelIds: ReadonlySet<string>;
  private readonly dynamicChannelIds = new Set<string>();
  private readonly maxDynamicChannels: number;
  private readonly channelsById: ReadonlyMap<string, CompiledChannelPolicy>;
  private readonly wildcardChannel?: CompiledChannelPolicy;
  private readonly dm: CompiledDmPolicy;
  private readonly conversationKinds: BoundedTtlCache<
    string,
    SlackConversationKind
  >;

  private constructor(params: {
    options: SlackAccountPolicyResolverOptions;
    groupPolicy: "legacy" | "open" | "disabled" | "allowlist";
    requireMention: boolean;
    allowBots: boolean;
    reactionMode: "off" | "own" | "all" | "allowlist";
    reactionAllowlist: ReadonlySet<string>;
    staticChannelIds: ReadonlySet<string>;
    channelsById: ReadonlyMap<string, CompiledChannelPolicy>;
    wildcardChannel?: CompiledChannelPolicy;
    dm: CompiledDmPolicy;
    conversationKinds: ReadonlyMap<string, SlackConversationKind>;
  }) {
    this.accountId = params.options.account.accountId;
    this.client = params.options.client;
    this.workspace = params.options.workspace;
    this.checkPairing = params.options.checkPairing;
    this.structured = params.options.account.hasStructuredPolicy;
    this.groupPolicy = params.groupPolicy;
    this.requireMention = params.requireMention;
    this.allowBots = params.allowBots;
    this.reactionMode = params.reactionMode;
    this.reactionAllowlist = params.reactionAllowlist;
    this.staticChannelIds = params.staticChannelIds;
    this.channelsById = params.channelsById;
    this.wildcardChannel = params.wildcardChannel;
    this.dm = params.dm;
    this.maxDynamicChannels = params.options.cache?.maxDynamicChannels ?? 1_024;
    this.conversationKinds = new BoundedTtlCache(
      params.options.cache?.maxConversationKinds ?? 1_024,
      params.options.cache?.conversationKindTtlMs ?? 15 * 60_000,
      params.options.cache?.now ?? Date.now,
    );
    for (const [id, kind] of params.conversationKinds) {
      this.conversationKinds.set(id, kind);
    }
  }

  static async create(
    options: SlackAccountPolicyResolverOptions,
  ): Promise<SlackAccountPolicyResolver> {
    const { account, client } = options;
    if (
      !options.workspace.teamId.trim() ||
      !options.workspace.botUserId.trim()
    ) {
      throw new SlackPolicyConfigurationError(
        "auth.test did not return a workspace team_id and bot user_id",
        account.accountId,
      );
    }
    for (const [key, value] of Object.entries({
      maxConversationKinds: options.cache?.maxConversationKinds ?? 1_024,
      conversationKindTtlMs:
        options.cache?.conversationKindTtlMs ?? 15 * 60_000,
      maxDynamicChannels: options.cache?.maxDynamicChannels ?? 1_024,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new SlackPolicyConfigurationError(
          `${key} must be a positive safe integer`,
          account.accountId,
        );
      }
    }
    assertSupportedSecurityPolicy(account);

    const channelEntries = Object.entries(account.channels);
    const needsChannelDirectory =
      channelEntries.some(
        ([key]) => key !== "*" && !isSlackChannelIdKey(key),
      ) || Boolean(account.dm?.groupChannels?.length);
    const needsUserDirectory =
      channelEntries.some(([, config]) =>
        requiresUserDirectory(config.users),
      ) || requiresUserDirectory(account.dm?.allowFrom);

    const channels = needsChannelDirectory
      ? await listAllChannels(client, account.accountId)
      : [];
    const users = needsUserDirectory
      ? await listAllUsers(client, account.accountId)
      : [];

    const channelsById = new Map<string, CompiledChannelPolicy>();
    let wildcardChannel: CompiledChannelPolicy | undefined;
    for (const [rawKey, config] of channelEntries) {
      const key = rawKey.trim();
      if (!key || !config) continue;
      const compiled = await compileChannelPolicy(
        account.accountId,
        key,
        config,
        users,
      );
      if (key === "*") {
        wildcardChannel = compiled;
        continue;
      }

      const channelId =
        extractExplicitChannelId(key) ??
        resolveUniqueChannelId(account.accountId, key, channels);
      if (channelsById.has(channelId)) {
        throw new SlackPolicyConfigurationError(
          `multiple channel policy entries resolve to ${channelId}`,
          account.accountId,
        );
      }
      channelsById.set(channelId, compiled);
    }

    const staticChannelIds = new Set(
      (account.config.allowedChannelIds ?? [])
        .map((id) => id.trim())
        .filter(Boolean),
    );
    const dm = await compileDmPolicy(account, channels, users);
    const reactionPolicy = compileReactionPolicy(account);
    const conversationKinds = new Map<string, SlackConversationKind>();
    const policyConversationIds = new Set(channelsById.keys());
    for (const id of dm.groupChannels ?? []) policyConversationIds.add(id);
    for (const channel of channels) {
      if (channel.id && policyConversationIds.has(channel.id)) {
        conversationKinds.set(channel.id, classifyDirectoryChannel(channel));
      }
    }
    const groupPolicy = account.hasStructuredPolicy
      ? (account.config.groupPolicy ?? "allowlist")
      : "legacy";
    const requireMention = account.hasStructuredPolicy
      ? (account.requireMention ?? true)
      : (account.config.shouldRespondOnlyToMentions ?? false);

    return new SlackAccountPolicyResolver({
      options,
      groupPolicy,
      requireMention,
      allowBots: account.hasStructuredPolicy
        ? (account.config.allowBots ?? false)
        : !(account.config.shouldIgnoreBotMessages ?? false),
      reactionMode: reactionPolicy.mode,
      reactionAllowlist: reactionPolicy.allowlist,
      staticChannelIds,
      channelsById,
      ...(wildcardChannel ? { wildcardChannel } : {}),
      dm,
      conversationKinds,
    });
  }

  async authorize(
    event: SlackInboundEventContext,
  ): Promise<SlackInboundPolicyDecision> {
    const workspaceDenial = this.workspaceDenial(event);
    if (workspaceDenial) return this.denied(event, workspaceDenial);
    const kind = await this.resolveConversationKind(event);
    if (!kind) {
      return this.denied(event, "unknown_conversation");
    }

    if (kind === "direct_message" || kind === "app_home") {
      return this.authorizeDirectMessage(event, kind);
    }
    if (kind === "multi_party_direct_message") {
      return this.authorizeGroupDirectMessage(event, kind);
    }
    return this.authorizeChannel(event, kind);
  }

  async authorizeReaction(
    event: SlackInboundEventContext,
    reaction: string,
  ): Promise<SlackInboundPolicyDecision> {
    if (event.userId === this.workspace.botUserId) {
      return this.denied(event, "bot_not_allowed");
    }
    const decision = await this.authorize(event);
    if (!decision.allowed) return decision;
    if (this.reactionMode === "off") {
      return this.denied(
        event,
        "reaction_disabled",
        decision.conversationKind,
        decision.channelPolicyKey,
      );
    }
    if (
      this.reactionMode === "allowlist" &&
      !this.reactionAllowlist.has(reaction)
    ) {
      return this.denied(
        event,
        "reaction_not_allowed",
        decision.conversationKind,
        decision.channelPolicyKey,
      );
    }
    return decision;
  }

  isReactionTargetAllowed(isOwnedByAgent: boolean): boolean {
    return this.reactionMode !== "own" || isOwnedByAgent;
  }

  workspaceDenial(input: {
    teamId?: string;
    enterpriseId?: string;
  }): "workspace_identity_missing" | "workspace_identity_mismatch" | null {
    if (!input.teamId?.trim()) return "workspace_identity_missing";
    if (input.teamId !== this.workspace.teamId) {
      return "workspace_identity_mismatch";
    }
    if (
      input.enterpriseId &&
      this.workspace.enterpriseId &&
      input.enterpriseId !== this.workspace.enterpriseId
    ) {
      return "workspace_identity_mismatch";
    }
    return null;
  }

  async registerBotJoin(channelId: string): Promise<boolean> {
    if (!this.structured) {
      if (this.staticChannelIds.size === 0) return true;
      while (this.dynamicChannelIds.size >= this.maxDynamicChannels) {
        const oldest = this.dynamicChannelIds.values().next().value;
        if (oldest === undefined) break;
        this.dynamicChannelIds.delete(oldest);
      }
      this.dynamicChannelIds.add(channelId);
      return true;
    }
    if (this.groupPolicy === "disabled") return false;
    if (this.groupPolicy === "open") return true;
    return this.isConfiguredChannelAllowed(channelId);
  }

  registerBotLeave(channelId: string): void {
    this.dynamicChannelIds.delete(channelId);
  }

  listAllowedChannelIds(): string[] {
    const ids = new Set(this.staticChannelIds);
    for (const id of this.dynamicChannelIds) ids.add(id);
    for (const [id, policy] of this.channelsById) {
      if (policy.allowed) ids.add(id);
    }
    return Array.from(ids).sort((a, b) => a.localeCompare(b));
  }

  isChannelAllowed(channelId: string): boolean {
    if (!this.structured) {
      if (
        this.staticChannelIds.size === 0 &&
        this.dynamicChannelIds.size === 0
      ) {
        return true;
      }
      return (
        this.staticChannelIds.has(channelId) ||
        this.dynamicChannelIds.has(channelId)
      );
    }
    if (this.groupPolicy === "disabled") return false;
    if (this.groupPolicy === "open") {
      return this.channelsById.get(channelId)?.allowed !== false;
    }
    return this.isConfiguredChannelAllowed(channelId);
  }

  private isConfiguredChannelAllowed(channelId: string): boolean {
    const channel = this.channelsById.get(channelId);
    if (channel) return channel.allowed;
    if (this.wildcardChannel) return this.wildcardChannel.allowed;
    return this.staticChannelIds.has(channelId);
  }

  private async authorizeDirectMessage(
    event: SlackInboundEventContext,
    kind: "direct_message" | "app_home",
  ): Promise<SlackInboundPolicyDecision> {
    if (event.isBotMessage && !this.allowBots) {
      return this.denied(event, "bot_not_allowed", kind);
    }
    if (!this.dm.enabled || this.dm.policy === "disabled") {
      return this.denied(event, "dm_disabled", kind);
    }
    if (this.dm.policy === "open") return this.allowed(event, kind);
    if (this.dm.users?.allowAll || this.dm.users?.ids.has(event.userId)) {
      return this.allowed(event, kind);
    }
    if (this.dm.policy === "allowlist") {
      return this.denied(event, "dm_user_not_allowed", kind);
    }

    const pairing = await this.checkPairing(event.userId);
    if (pairing.allowed) return this.allowed(event, kind);
    return {
      ...this.denied(event, "pairing_required", kind),
      ...(pairing.replyMessage ? { pairingReply: pairing.replyMessage } : {}),
    };
  }

  private authorizeGroupDirectMessage(
    event: SlackInboundEventContext,
    kind: "multi_party_direct_message",
  ): SlackInboundPolicyDecision {
    if (event.isBotMessage && !this.allowBots) {
      return this.denied(event, "bot_not_allowed", kind);
    }
    if (!this.dm.enabled || !this.dm.groupEnabled) {
      return this.denied(event, "group_dm_disabled", kind);
    }
    if (this.dm.groupChannels && !this.dm.groupChannels.has(event.channelId)) {
      return this.denied(event, "group_dm_not_allowed", kind);
    }
    return this.allowed(event, kind);
  }

  private authorizeChannel(
    event: SlackInboundEventContext,
    kind: "public_channel" | "private_channel",
  ): SlackInboundPolicyDecision {
    const channel =
      this.channelsById.get(event.channelId) ?? this.wildcardChannel;
    if (channel && !channel.allowed) {
      return this.denied(event, "channel_disabled", kind, channel.key);
    }
    if (!this.isChannelAllowed(event.channelId)) {
      return this.denied(event, "channel_not_allowed", kind, channel?.key);
    }
    if (event.isBotMessage && !(channel?.allowBots ?? this.allowBots)) {
      return this.denied(event, "bot_not_allowed", kind, channel?.key);
    }
    if (
      channel?.users &&
      !channel.users.allowAll &&
      !channel.users.ids.has(event.userId)
    ) {
      return this.denied(event, "user_not_allowed", kind, channel.key);
    }
    if (
      event.eventType === "message" &&
      (channel?.requireMention ?? this.requireMention) &&
      !event.isMentioned
    ) {
      return this.denied(event, "mention_required", kind, channel?.key);
    }
    return this.allowed(event, kind, channel?.key);
  }

  private async resolveConversationKind(
    event: SlackInboundEventContext,
  ): Promise<SlackConversationKind | null> {
    const inline = classifyEventShape(event.channelType, event.subtype);
    if (inline) return inline;
    const cached = this.conversationKinds.get(event.channelId);
    if (cached) return cached;
    const result = await this.client.conversations.info({
      channel: event.channelId,
    });
    if (!result.channel) return null;
    const kind = classifyDirectoryChannel(result.channel);
    this.conversationKinds.set(event.channelId, kind);
    return kind;
  }

  private allowed(
    event: SlackInboundEventContext,
    conversationKind: SlackConversationKind,
    channelPolicyKey?: string,
  ): SlackInboundPolicyDecision {
    return {
      allowed: true,
      conversationKind,
      isThread: event.isThread,
      ...(channelPolicyKey ? { channelPolicyKey } : {}),
    };
  }

  private denied(
    event: SlackInboundEventContext,
    reason: SlackInboundDenyReason,
    conversationKind?: SlackConversationKind,
    channelPolicyKey?: string,
  ): SlackInboundPolicyDecision {
    return {
      allowed: false,
      reason,
      isThread: event.isThread,
      ...(conversationKind ? { conversationKind } : {}),
      ...(channelPolicyKey ? { channelPolicyKey } : {}),
    };
  }
}

export function normalizeSlackSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/^[#@]/, "")
    .replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = slug.length;
  while (start < end && slug.charCodeAt(start) === 45) start += 1;
  while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1;
  return slug.slice(start, end);
}

export function isSlackChannelIdKey(key: string): boolean {
  return extractExplicitChannelId(key) !== null;
}

function extractExplicitChannelId(value: string): string | null {
  const trimmed = value.trim();
  const explicit = trimmed.match(/^(?:id|slack-id):(.+)$/i)?.[1]?.trim();
  if (explicit) return explicit;
  return /^[CGD][A-Z0-9]{8,}$/i.test(trimmed) ? trimmed : null;
}

function assertSupportedSecurityPolicy(account: ResolvedSlackAccount): void {
  const unsupported: string[] = [];
  const config = account.config;
  if (config.mode === "http") unsupported.push("mode=http");
  for (const key of [
    "actions",
    "commands",
    "configWrites",
    "dms",
    "heartbeat",
    "historyLimit",
    "dmHistoryLimit",
    "slashCommand",
    "thread",
  ] as const) {
    if (config[key] !== undefined) unsupported.push(key);
  }
  for (const [channel, policy] of Object.entries(account.channels)) {
    for (const key of [
      "tools",
      "toolsBySender",
      "skills",
      "systemPrompt",
    ] as const) {
      if (policy[key] !== undefined)
        unsupported.push(`channels.${channel}.${key}`);
    }
  }
  if (unsupported.length > 0) {
    throw new SlackPolicyConfigurationError(
      `configuration contains policy fields the connector cannot enforce: ${unsupported.join(", ")}`,
      account.accountId,
    );
  }
}

function compileReactionPolicy(account: ResolvedSlackAccount): {
  mode: "off" | "own" | "all" | "allowlist";
  allowlist: ReadonlySet<string>;
} {
  const mode = account.config.reactionNotifications ?? "own";
  const rawAllowlist = account.config.reactionAllowlist;
  if (mode !== "allowlist" && rawAllowlist !== undefined) {
    throw new SlackPolicyConfigurationError(
      "reactionAllowlist requires reactionNotifications=allowlist",
      account.accountId,
    );
  }
  if (mode === "allowlist" && (!rawAllowlist || rawAllowlist.length === 0)) {
    throw new SlackPolicyConfigurationError(
      "reactionNotifications=allowlist requires at least one reaction name",
      account.accountId,
    );
  }

  const allowlist = new Set<string>();
  for (const raw of rawAllowlist ?? []) {
    if (typeof raw !== "string") {
      throw new SlackPolicyConfigurationError(
        "reactionAllowlist entries must be Slack reaction names",
        account.accountId,
      );
    }
    const reaction = raw.trim().toLowerCase().replace(/^:|:$/g, "");
    if (!/^[a-z0-9_+-]+(?:::skin-tone-[2-6])?$/.test(reaction)) {
      throw new SlackPolicyConfigurationError(
        `reactionAllowlist contains invalid Slack reaction name ${JSON.stringify(raw)}`,
        account.accountId,
      );
    }
    allowlist.add(reaction);
  }
  return { mode, allowlist };
}

async function compileChannelPolicy(
  accountId: string,
  key: string,
  config: SlackChannelConfig,
  users: SlackDirectoryUser[],
): Promise<CompiledChannelPolicy> {
  return {
    key,
    allowed: config.enabled !== false && config.allow !== false,
    ...(config.requireMention !== undefined
      ? { requireMention: config.requireMention }
      : {}),
    ...(config.allowBots !== undefined ? { allowBots: config.allowBots } : {}),
    ...(config.users !== undefined
      ? {
          users: resolveIdentitySet(
            accountId,
            `channels.${key}.users`,
            config.users,
            users,
          ),
        }
      : {}),
  };
}

async function compileDmPolicy(
  account: ResolvedSlackAccount,
  channels: SlackDirectoryChannel[],
  users: SlackDirectoryUser[],
): Promise<CompiledDmPolicy> {
  if (!account.hasStructuredPolicy) {
    return {
      enabled: true,
      policy: "open",
      groupEnabled: true,
    };
  }
  const config = account.dm;
  const policy = config?.policy ?? "pairing";
  const userSet =
    config?.allowFrom !== undefined
      ? resolveIdentitySet(
          account.accountId,
          "dm.allowFrom",
          config.allowFrom,
          users,
        )
      : undefined;
  if (policy === "open" && !userSet?.allowAll) {
    throw new SlackPolicyConfigurationError(
      'dm.policy="open" requires dm.allowFrom=["*"]',
      account.accountId,
    );
  }

  const groupChannels =
    config?.groupChannels === undefined
      ? undefined
      : new Set(
          config.groupChannels.map((entry) => {
            const value = String(entry).trim();
            if (!value) {
              throw new SlackPolicyConfigurationError(
                "dm.groupChannels contains an empty entry",
                account.accountId,
              );
            }
            return (
              extractExplicitChannelId(value) ??
              resolveUniqueChannelId(account.accountId, value, channels)
            );
          }),
        );

  return {
    enabled: config?.enabled !== false,
    policy,
    ...(userSet ? { users: userSet } : {}),
    groupEnabled: config?.groupEnabled === true,
    ...(groupChannels ? { groupChannels } : {}),
  };
}

function resolveIdentitySet(
  accountId: string,
  path: string,
  entries: Array<string | number>,
  users: SlackDirectoryUser[],
): CompiledIdentitySet {
  const ids = new Set<string>();
  let allowAll = false;
  for (const raw of entries) {
    const value = String(raw).trim();
    if (!value) {
      throw new SlackPolicyConfigurationError(
        `${path} contains an empty entry`,
        accountId,
      );
    }
    if (value === "*") {
      allowAll = true;
      continue;
    }
    const explicitId = extractExplicitUserId(value);
    if (explicitId) {
      ids.add(explicitId);
      continue;
    }
    ids.add(resolveUniqueUserId(accountId, path, value, users));
  }
  return { allowAll, ids };
}

function extractExplicitUserId(value: string): string | null {
  const mention = value.match(/^<@([^>|]+)(?:\|[^>]+)?>$/);
  if (mention?.[1]) return mention[1];
  const explicit = value.match(/^(?:id|slack-id):(.+)$/i);
  return explicit?.[1]?.trim() || null;
}

function requiresUserDirectory(
  entries: Array<string | number> | undefined,
): boolean {
  return Boolean(
    entries?.some((entry) => {
      const value = String(entry).trim();
      return value !== "*" && !extractExplicitUserId(value);
    }),
  );
}

function resolveUniqueUserId(
  accountId: string,
  path: string,
  value: string,
  users: SlackDirectoryUser[],
): string {
  const exactId = users.filter((user) => user.id === value);
  if (exactId.length === 1 && exactId[0]?.id) return exactId[0].id;

  const slug = normalizeSlackSlug(value);
  const matches = users.filter((user) => {
    if (user.deleted || !user.id) return false;
    return userAliases(user).some(
      (alias) => normalizeSlackSlug(alias) === slug,
    );
  });
  if (matches.length !== 1 || !matches[0]?.id) {
    throw new SlackPolicyConfigurationError(
      `${path} entry ${JSON.stringify(value)} resolved to ${matches.length} active users; use id:<opaque-slack-id>`,
      accountId,
    );
  }
  return matches[0].id;
}

function userAliases(user: SlackDirectoryUser): string[] {
  return [
    user.name,
    user.real_name,
    user.profile?.display_name,
    user.profile?.display_name_normalized,
    user.profile?.real_name,
    user.profile?.real_name_normalized,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function resolveUniqueChannelId(
  accountId: string,
  value: string,
  channels: SlackDirectoryChannel[],
): string {
  const slug = normalizeSlackSlug(value);
  const matches = channels.filter(
    (channel) =>
      channel.id &&
      [channel.name, channel.name_normalized].some(
        (name) => name && normalizeSlackSlug(name) === slug,
      ),
  );
  if (matches.length !== 1 || !matches[0]?.id) {
    throw new SlackPolicyConfigurationError(
      `channel entry ${JSON.stringify(value)} resolved to ${matches.length} conversations; use an immutable Slack channel ID`,
      accountId,
    );
  }
  return matches[0].id;
}

function classifyEventShape(
  channelType?: string,
  subtype?: string,
): SlackConversationKind | null {
  if (channelType === "app_home" || subtype === "app_home") return "app_home";
  if (channelType === "im") return "direct_message";
  if (channelType === "mpim") return "multi_party_direct_message";
  if (channelType === "group") return "private_channel";
  if (channelType === "channel") return "public_channel";
  return null;
}

function classifyDirectoryChannel(
  channel: SlackDirectoryChannel,
): SlackConversationKind {
  if (channel.is_im) return "direct_message";
  if (channel.is_mpim) return "multi_party_direct_message";
  if (channel.is_group || channel.is_private) return "private_channel";
  return "public_channel";
}

export const MAX_SLACK_DIRECTORY_PAGES = 250;

async function listAllChannels(
  client: SlackPolicyDirectoryClient,
  accountId: string,
): Promise<SlackDirectoryChannel[]> {
  const result: SlackDirectoryChannel[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MAX_SLACK_DIRECTORY_PAGES) {
      throw new SlackPolicyConfigurationError(
        "channel directory exceeds the 250-page safety limit; use immutable IDs only",
        accountId,
      );
    }
    const page = await client.conversations.list({
      ...(cursor ? { cursor } : {}),
      limit: 200,
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: true,
    });
    const channels = page.channels ?? [];
    if (result.length + channels.length > 50_000) {
      throw new SlackPolicyConfigurationError(
        "channel directory exceeds the 50,000-entry startup safety limit; use immutable IDs only",
        accountId,
      );
    }
    result.push(...channels);
    const next = page.response_metadata?.next_cursor?.trim() || undefined;
    if (next && seenCursors.has(next)) {
      throw new SlackPolicyConfigurationError(
        "Slack conversations.list returned a repeated cursor",
        accountId,
      );
    }
    if (next) seenCursors.add(next);
    cursor = next;
  } while (cursor);
  return result;
}

async function listAllUsers(
  client: SlackPolicyDirectoryClient,
  accountId: string,
): Promise<SlackDirectoryUser[]> {
  const result: SlackDirectoryUser[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MAX_SLACK_DIRECTORY_PAGES) {
      throw new SlackPolicyConfigurationError(
        "user directory exceeds the 250-page safety limit; use explicit id:<opaque-slack-id> entries",
        accountId,
      );
    }
    const page = await client.users.list({
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    const members = page.members ?? [];
    if (result.length + members.length > 50_000) {
      throw new SlackPolicyConfigurationError(
        "user directory exceeds the 50,000-entry startup safety limit; use explicit id:<opaque-slack-id> entries",
        accountId,
      );
    }
    result.push(...members);
    const next = page.response_metadata?.next_cursor?.trim() || undefined;
    if (next && seenCursors.has(next)) {
      throw new SlackPolicyConfigurationError(
        "Slack users.list returned a repeated cursor",
        accountId,
      );
    }
    if (next) seenCursors.add(next);
    cursor = next;
  } while (cursor);
  return result;
}
