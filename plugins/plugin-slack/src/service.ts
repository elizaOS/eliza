/**
 * `SlackService` — the Socket Mode connection manager and message connector that
 * gives an Eliza agent its live Slack presence. On start it opens one `@slack/bolt`
 * `App` per configured workspace account, registers the bolt event handlers, and
 * registers itself as a `MessageConnector` so the runtime can send, read, search,
 * react to, edit, delete, and pin messages across channels, threads, and DMs.
 *
 * Inbound Slack events are mapped into the runtime's message envelope
 * (`createUniqueUuid` / `stringToUuid` for stable room/entity IDs) and emitted as
 * `SlackEventTypes`; outbound `Content` is rendered to Slack mrkdwn via
 * `formatting.ts` and posted through the account's web client. Media attachments
 * are fetched through the SSRF-guarded `resolveAttachmentBytes` and uploaded as
 * file bytes rather than URLs.
 *
 * Multi-account state lives in a `Map<string, SlackAccountRuntime>`; the default
 * account is the first entry. OWNER-role accounts with a user token (`xoxp-`) post
 * as the user, AGENT-role accounts (the default) post as the bot (`xoxb-`).
 * Each account compiles its persisted Slack authorization policy before Bolt
 * starts. Public/private channels, direct messages, App Home, MPIMs, threads,
 * and app mentions all pass through that account-scoped resolver, then claim
 * their stable persisted memory before emission or agent processing so Slack
 * retries cannot execute one event twice.
 */
import {
  ChannelType,
  type Character,
  type Content,
  checkPairingAllowed,
  createUniqueUuid,
  decodeCallback,
  ElizaError,
  type EventPayload,
  EventType,
  getConnectorAdminWhitelist,
  type HandlerCallback,
  type IAgentRuntime,
  type IMessageService,
  type Media,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  type MessageMetadata,
  type MessagePayload,
  type Room,
  resolveAttachmentBytes,
  resolveFirstPartyInteractionProfile,
  Service,
  stringToUuid,
  type TargetInfo,
  type UUID,
  type World,
} from "@elizaos/core";
import { App, LogLevel } from "@slack/bolt";
import {
  WebClient as SlackWebClient,
  type WebAPICallResult,
} from "@slack/web-api";

type WebClient = App["client"];
type AccountScopedTargetInfo = TargetInfo & { accountId?: string };
type AccountScopedConnectorContext = MessageConnectorQueryContext & {
  accountId?: string;
  account?: { accountId?: string };
};
type MessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0];

type ConnectorFetchMessagesParams = {
  target?: TargetInfo;
  accountId?: string;
  limit?: number;
  before?: string;
  after?: string;
  cursor?: string;
  channelId?: string;
  roomId?: UUID;
  threadId?: string;
};

type ConnectorSearchMessagesParams = ConnectorFetchMessagesParams & {
  query?: string;
};

type ConnectorMessageMutationParams = {
  target?: TargetInfo;
  accountId?: string;
  channelId?: string;
  roomId?: UUID;
  threadId?: string;
  messageId?: string;
  messageTs?: string;
  emoji?: string;
  remove?: boolean;
  pin?: boolean;
  text?: string;
  content?: Content;
};

type ConnectorUserLookupParams = {
  target?: TargetInfo;
  userId?: string;
  username?: string;
  handle?: string;
  query?: string;
};

type ExtendedMessageConnectorRegistration = MessageConnectorRegistration & {
  listServers?: (context: MessageConnectorQueryContext) => Promise<World[]>;
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params: ConnectorFetchMessagesParams,
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: MessageConnectorQueryContext,
    params: ConnectorSearchMessagesParams,
  ) => Promise<Memory[]>;
  reactHandler?: (
    runtime: IAgentRuntime,
    params: ConnectorMessageMutationParams,
  ) => Promise<void>;
  editHandler?: (
    runtime: IAgentRuntime,
    params: ConnectorMessageMutationParams,
  ) => Promise<Memory>;
  deleteHandler?: (
    runtime: IAgentRuntime,
    params: ConnectorMessageMutationParams,
  ) => Promise<void>;
  pinHandler?: (
    runtime: IAgentRuntime,
    params: ConnectorMessageMutationParams,
  ) => Promise<void>;
  getUser?: (
    runtime: IAgentRuntime,
    params: ConnectorUserLookupParams,
  ) => Promise<unknown>;
};

type SlackApiUserProfile = {
  title?: string;
  phone?: string;
  skype?: string;
  real_name?: string;
  real_name_normalized?: string;
  display_name?: string;
  display_name_normalized?: string;
  status_text?: string;
  status_emoji?: string;
  status_expiration?: number;
  avatar_hash?: string;
  email?: string;
  image_24?: string;
  image_32?: string;
  image_48?: string;
  image_72?: string;
  image_192?: string;
  image_512?: string;
  image_1024?: string;
  image_original?: string;
  team?: string;
};

type SlackApiUserMember = {
  id?: string;
  team_id?: string;
  name?: string;
  deleted?: boolean;
  real_name?: string;
  tz?: string;
  tz_label?: string;
  tz_offset?: number;
  profile?: SlackApiUserProfile;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  updated?: number;
};

const SLACK_CONNECTOR_CONTEXTS = ["social", "connectors"];
const SLACK_CONNECTOR_CAPABILITIES = [
  "send_message",
  "read_messages",
  "search_messages",
  "resolve_targets",
  "list_rooms",
  "list_servers",
  "chat_context",
  "user_context",
  "react_message",
  "edit_message",
  "delete_message",
  "pin_message",
  "get_user",
];
const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/i;

function normalizeSlackConnectorQuery(value: string): string {
  return value
    .trim()
    .replace(/^<#([A-Z0-9]+)(?:\|[^>]+)?>$/i, "$1")
    .replace(/^<@([A-Z0-9]+)>$/i, "$1")
    .replace(/^#/, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function scoreSlackConnectorMatch(
  query: string,
  id: string,
  labels: Array<string | null | undefined>,
): number {
  if (!query) {
    return 0.45;
  }
  if (id.toLowerCase() === query) {
    return 1;
  }

  let bestScore = 0;
  for (const label of labels) {
    const normalized = label?.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized === query) {
      bestScore = Math.max(bestScore, 0.95);
    } else if (normalized.startsWith(query)) {
      bestScore = Math.max(bestScore, 0.85);
    } else if (normalized.includes(query)) {
      bestScore = Math.max(bestScore, 0.7);
    }
  }
  return bestScore;
}

function extractSlackUserIdFromMetadata(
  metadata: unknown,
  accountId?: string | null,
): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const slack =
    record.slack && typeof record.slack === "object"
      ? (record.slack as Record<string, unknown>)
      : null;

  const metadataAccountId =
    typeof record.accountId === "string"
      ? record.accountId
      : typeof slack?.accountId === "string"
        ? slack.accountId
        : undefined;
  if (
    accountId &&
    metadataAccountId &&
    normalizeAccountId(metadataAccountId) !== normalizeAccountId(accountId)
  ) {
    return null;
  }

  const candidates = [
    slack?.userId,
    slack?.id,
    record.slackUserId,
    record.originalId,
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      SLACK_USER_ID_PATTERN.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function isValidSlackEmojiName(emoji: string): boolean {
  return /^[A-Za-z0-9_+-]+(::skin-tone-[2-6])?$/.test(emoji);
}

function normalizeSlackEmojiName(emoji: string): string {
  const value = emoji.trim();
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 58) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 58) end -= 1;
  return value.slice(start, end);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeConnectorLimit(
  limit: number | undefined,
  fallback: number,
  max = 100,
): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(limit), max));
}

// Define Slack event types inline to avoid import issues
interface SlackMessageEventType {
  type: "message";
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  team?: string;
  bot_id?: string;
  files?: SlackFile[];
}

interface SlackAppMentionEventType {
  type: "app_mention";
  channel: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  event_ts: string;
}

interface SlackReactionEventType {
  user: string;
  reaction: string;
  item: { type: "message"; channel: string; ts: string };
  item_user?: string;
  event_ts: string;
}

type SlackInboundClaim = {
  accountId: string;
  teamId: string;
  enterpriseId?: string;
  eventId: string;
  recordId: string;
  token: string;
};

function extractSlackDeliveryEventId(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const eventId = (body as Record<string, unknown>).event_id;
    if (typeof eventId === "string") {
      const normalized = eventId.trim();
      if (normalized.length > 0 && normalized.length <= 255) {
        return normalized;
      }
    }
  }
  return fallback;
}

function readSlackInboundClaim(
  memory: Memory | null,
): SlackInboundClaim | null {
  const claim = (memory?.metadata as MessageMetadata | undefined)
    ?.slackInboundClaim;
  if (!claim || typeof claim !== "object") return null;
  const record = claim as Record<string, unknown>;
  if (
    typeof record.accountId !== "string" ||
    typeof record.teamId !== "string" ||
    typeof record.eventId !== "string" ||
    typeof record.recordId !== "string" ||
    typeof record.token !== "string"
  ) {
    return null;
  }
  return {
    accountId: record.accountId,
    teamId: record.teamId,
    ...(typeof record.enterpriseId === "string"
      ? { enterpriseId: record.enterpriseId }
      : {}),
    eventId: record.eventId,
    recordId: record.recordId,
    token: record.token,
  };
}

// Helper to get message service from runtime
const getMessageService = (runtime: IAgentRuntime): IMessageService | null => {
  if ("messageService" in runtime) {
    const withMessageService = runtime as IAgentRuntime & {
      messageService?: IMessageService | null;
    };
    return withMessageService.messageService ?? null;
  }
  return null;
};

import {
  DEFAULT_ACCOUNT_ID,
  listEnabledSlackAccounts,
  normalizeAccountId,
  type ResolvedSlackAccount,
  resolveDefaultSlackAccountId,
} from "./accounts";
import { markdownToSlackMrkdwn, splitSlackText } from "./formatting";
import { buildSlackInteractionPayload } from "./interactions";
import {
  extractSlackEventWorkspace,
  SlackAccountPolicyResolver,
  type SlackInboundPolicyDecision,
  type SlackPolicyDirectoryClient,
} from "./policy";
import {
  getSlackChannelType,
  getSlackUserDisplayName,
  type ISlackService,
  isValidChannelId,
  isValidMessageTs,
  isValidUserId,
  MAX_SLACK_MESSAGE_LENGTH,
  SLACK_SERVICE_NAME,
  type SlackAttachment,
  type SlackBlock,
  type SlackChannel,
  SlackEventTypes,
  type SlackFile,
  type SlackMessage,
  type SlackMessageSendOptions,
  type SlackReactionPayload,
  type SlackUser,
} from "./types";

type SlackAccountRuntime = {
  accountId: string;
  account: ResolvedSlackAccount;
  app: App;
  client: WebClient;
  /**
   * Optional xoxp- user-token client. Present only when the account
   * has a `userToken` configured. OWNER-role accounts route outbound
   * calls covered by the granted user scopes (currently `chat:write`)
   * through this client so the agent acts as the user; AGENT-role
   * accounts ignore it and keep using the bot client.
   */
  userClient: WebClient | null;
  botUserId: string | null;
  teamId: string | null;
  policy: SlackAccountPolicyResolver;
  userCache: Map<string, SlackUser>;
  channelCache: Map<string, SlackChannel>;
  isConnected: boolean;
};

const MAX_SLACK_LOOKUP_CACHE_ENTRIES = 1_024;

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  while (cache.size >= MAX_SLACK_LOOKUP_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

/**
 * SlackService class for interacting with Slack via Socket Mode
 */
export class SlackService extends Service implements ISlackService {
  static serviceType: string = SLACK_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive messages on Slack";

  app: App | null = null;
  client: WebClient | null = null;
  character: Character;
  botUserId: string | null = null;
  teamId: string | null = null;

  private botToken: string | null = null;
  private appToken: string | null = null;
  private signingSecret: string | null = null;
  private defaultAccountId = DEFAULT_ACCOUNT_ID;
  private accountStates: Map<string, SlackAccountRuntime> = new Map();
  private accountStarts: Map<string, Promise<SlackAccountRuntime>> = new Map();
  private userCache: Map<string, SlackUser> = new Map();
  private channelCache: Map<string, SlackChannel> = new Map();
  private isConnected = false;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.character = this.runtime.character;
  }

  static async start(runtime: IAgentRuntime): Promise<SlackService> {
    const service = new SlackService(runtime);

    const accounts = listEnabledSlackAccounts(runtime);
    service.defaultAccountId = resolveDefaultSlackAccountId(runtime);

    if (accounts.length === 0) {
      runtime.logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "No enabled Slack accounts configured, Slack service will not start",
      );
      return service;
    }

    let startedAccounts = 0;
    let lastError: unknown;
    for (const account of accounts) {
      if (!account.appToken?.trim()) {
        runtime.logger.warn(
          {
            src: "plugin:slack",
            agentId: runtime.agentId,
            accountId: account.accountId,
          },
          "SLACK_APP_TOKEN not provided for Slack account, Socket Mode will not work",
        );
        continue;
      }

      try {
        await service.initializeAccount(account);
        startedAccounts++;
      } catch (error) {
        lastError = error;
        runtime.reportError("slack-account-start", error, {
          accountId: account.accountId,
        });
        runtime.logger.error(
          {
            src: "plugin:slack",
            agentId: runtime.agentId,
            accountId: account.accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to initialize Slack account",
        );
      }
    }

    if (startedAccounts === 0) {
      if (lastError) {
        throw lastError;
      }
      runtime.logger.warn(
        { src: "plugin:slack", agentId: runtime.agentId },
        "Slack service started without connected accounts",
      );
    }

    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(SLACK_SERVICE_NAME) as
      | SlackService
      | undefined;
    if (service) {
      await service.shutdown();
    }
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: SlackService,
  ): void {
    if (!serviceInstance) {
      return;
    }

    const registerConnector = (accountId?: string) => {
      const normalizedAccountId = accountId
        ? normalizeAccountId(accountId)
        : undefined;
      const state = normalizedAccountId
        ? serviceInstance.getAccountState(normalizedAccountId)
        : serviceInstance.getDefaultAccountState();
      const sendHandler = async (
        handlerRuntime: IAgentRuntime,
        target: TargetInfo,
        content: Content,
      ): Promise<void> => {
        await serviceInstance.handleSendMessage(
          handlerRuntime,
          normalizedAccountId && !(target as AccountScopedTargetInfo).accountId
            ? ({ ...target, accountId: normalizedAccountId } as TargetInfo)
            : target,
          content,
        );
      };

      const withContextAccount = (
        context: MessageConnectorQueryContext,
      ): MessageConnectorQueryContext =>
        normalizedAccountId &&
        !(context as AccountScopedConnectorContext).accountId
          ? ({
              ...context,
              accountId: normalizedAccountId,
              account: (context as AccountScopedConnectorContext).account ?? {
                source: "slack",
                accountId: normalizedAccountId,
                label: state?.account.name ?? normalizedAccountId,
              },
            } as MessageConnectorQueryContext)
          : context;

      const registration: ExtendedMessageConnectorRegistration = {
        source: "slack",
        ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
        ...(normalizedAccountId
          ? {
              account: {
                source: "slack",
                accountId: normalizedAccountId,
                label: state?.account.name ?? normalizedAccountId,
                authMethod: "BOT_TOKEN",
                metadata: {
                  teamId: state?.teamId,
                },
              },
            }
          : {}),
        label: state?.account.name ? `Slack (${state.account.name})` : "Slack",
        description:
          "Slack connector for sending, reading, searching, reacting to, editing, deleting, and pinning messages in channels, threads, and users.",
        capabilities: [...SLACK_CONNECTOR_CAPABILITIES],
        supportedTargetKinds: ["channel", "thread", "user"],
        contexts: [...SLACK_CONNECTOR_CONTEXTS],
        metadata: {
          service: SLACK_SERVICE_NAME,
          maxMessageLength: MAX_SLACK_MESSAGE_LENGTH,
          ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
        },
        resolveInteractionProfile: (target, context) =>
          resolveFirstPartyInteractionProfile({
            source: "slack",
            defaultAccountId: normalizedAccountId ?? DEFAULT_ACCOUNT_ID,
            defaultTargetKind: "channel",
            target,
            accountId: normalizedAccountId ?? context.accountId,
          }),
        resolveTargets: (query, context) =>
          serviceInstance.resolveConnectorTargets(
            query,
            withContextAccount(context),
          ),
        listRecentTargets: (context) =>
          serviceInstance.listRecentConnectorTargets(
            withContextAccount(context),
          ),
        listRooms: (context) =>
          serviceInstance.listConnectorRooms(withContextAccount(context)),
        listServers: (context) =>
          serviceInstance.listConnectorServers(withContextAccount(context)),
        fetchMessages: (context, params: ConnectorFetchMessagesParams) =>
          serviceInstance.fetchConnectorMessages(withContextAccount(context), {
            ...params,
            ...(normalizedAccountId && !params.accountId
              ? { accountId: normalizedAccountId }
              : {}),
          }),
        searchMessages: (context, params: ConnectorSearchMessagesParams) =>
          serviceInstance.searchConnectorMessages(withContextAccount(context), {
            ...params,
            ...(normalizedAccountId && !params.accountId
              ? { accountId: normalizedAccountId }
              : {}),
          }),
        reactHandler: (
          handlerRuntime,
          params: ConnectorMessageMutationParams,
        ) =>
          serviceInstance.reactConnectorMessage(handlerRuntime, {
            ...params,
            ...(normalizedAccountId && !params.accountId
              ? { accountId: normalizedAccountId }
              : {}),
          }),
        editHandler: (handlerRuntime, params: ConnectorMessageMutationParams) =>
          serviceInstance.editConnectorMessage(handlerRuntime, {
            ...params,
            ...(normalizedAccountId && !params.accountId
              ? { accountId: normalizedAccountId }
              : {}),
          }),
        deleteHandler: (
          handlerRuntime,
          params: ConnectorMessageMutationParams,
        ) =>
          serviceInstance.deleteConnectorMessage(handlerRuntime, {
            ...params,
            ...(normalizedAccountId && !params.accountId
              ? { accountId: normalizedAccountId }
              : {}),
          }),
        pinHandler: (handlerRuntime, params: ConnectorMessageMutationParams) =>
          serviceInstance.pinConnectorMessage(handlerRuntime, {
            ...params,
            ...(normalizedAccountId && !params.accountId
              ? { accountId: normalizedAccountId }
              : {}),
          }),
        getUser: (handlerRuntime, params) =>
          serviceInstance.getConnectorUser(handlerRuntime, {
            ...params,
            ...(normalizedAccountId && !params.target
              ? {
                  target: {
                    source: "slack",
                    accountId: normalizedAccountId,
                  } as TargetInfo,
                }
              : {}),
          }),
        getChatContext: (target, context) =>
          serviceInstance.getConnectorChatContext(
            normalizedAccountId &&
              !(target as AccountScopedTargetInfo).accountId
              ? ({ ...target, accountId: normalizedAccountId } as TargetInfo)
              : target,
            withContextAccount(context),
          ),
        getUserContext: (entityId, context) =>
          serviceInstance.getConnectorUserContext(
            entityId,
            withContextAccount(context),
          ),
        sendHandler,
      };

      runtime.registerMessageConnector(registration);
    };

    if (typeof runtime.registerMessageConnector === "function") {
      registerConnector();
      for (const accountId of serviceInstance.getRegisteredAccountIds()) {
        registerConnector(accountId);
      }
      runtime.logger.info(
        { src: "plugin:slack", agentId: runtime.agentId },
        "Registered Slack message connector",
      );
      return;
    }

    runtime.registerSendHandler(
      "slack",
      serviceInstance.handleSendMessage.bind(serviceInstance),
    );
    runtime.logger.info(
      { src: "plugin:slack", agentId: runtime.agentId },
      "Registered Slack send handler",
    );
  }

  async stop(): Promise<void> {
    await this.shutdown();
  }

  private syncDefaultAccountAliases(): void {
    const state = this.getDefaultAccountState();
    this.app = state?.app ?? null;
    this.client = state?.client ?? null;
    this.botUserId = state?.botUserId ?? null;
    this.teamId = state?.teamId ?? null;
    this.botToken = state?.account.botToken ?? null;
    this.appToken = state?.account.appToken ?? null;
    this.signingSecret = state?.account.signingSecret ?? null;
    this.isConnected = Array.from(this.accountStates.values()).some(
      (accountState) => accountState.isConnected,
    );
  }

  private async initializeAccount(
    account: ResolvedSlackAccount,
  ): Promise<SlackAccountRuntime> {
    const accountId = normalizeAccountId(account.accountId);
    const cached = this.accountStates.get(accountId);
    if (cached) {
      return cached;
    }

    const starting = this.accountStarts.get(accountId);
    if (starting) {
      return starting;
    }

    const startPromise = (async () => {
      if (!account.botToken || !account.appToken) {
        throw new Error(
          `Slack account ${accountId} requires bot and app tokens`,
        );
      }

      this.runtime.logger.info(
        { src: "plugin:slack", agentId: this.runtime.agentId, accountId },
        "Initializing Slack service with Socket Mode",
      );

      const app = new App({
        token: account.botToken,
        appToken: account.appToken,
        socketMode: true,
        logLevel: LogLevel.INFO,
        ...(account.signingSecret
          ? { signingSecret: account.signingSecret }
          : {}),
      });

      // User-token client (xoxp-) is outbound-only; no socket-mode
      // session is needed. Only constructed when a user token is
      // configured. Routing decisions in getOutboundClient() consult
      // account.role to decide which client receives each call.
      // `WebClient` is the alias for `App["client"]`, which is the
      // same `@slack/web-api` `WebClient` class imported here as
      // `SlackWebClient` — a direct `as WebClient` cast is correct
      // and a future type divergence will surface as an error here.
      const userClient = account.userToken
        ? (new SlackWebClient(account.userToken) as WebClient)
        : null;

      const authResult = await app.client.auth.test();
      const botUserId =
        typeof authResult.user_id === "string" ? authResult.user_id.trim() : "";
      const teamId =
        typeof authResult.team_id === "string" ? authResult.team_id.trim() : "";
      if (!botUserId || !teamId) {
        throw new ElizaError(
          "Slack auth.test did not return bot user and workspace identity",
          {
            code: "SLACK_AUTH_IDENTITY_MISSING",
            context: {
              accountId,
              hasBotUserId: Boolean(botUserId),
              hasTeamId: Boolean(teamId),
            },
          },
        );
      }
      const enterpriseId =
        typeof (authResult as { enterprise_id?: unknown }).enterprise_id ===
        "string"
          ? (authResult as { enterprise_id: string }).enterprise_id.trim()
          : undefined;
      const policy = await SlackAccountPolicyResolver.create({
        account,
        client: app.client as unknown as SlackPolicyDirectoryClient,
        workspace: {
          teamId,
          botUserId,
          ...(enterpriseId ? { enterpriseId } : {}),
        },
        checkPairing: async (userId) => {
          const adminIds = getConnectorAdminWhitelist(this.runtime).slack ?? [];
          if (adminIds.includes(userId)) return { allowed: true };
          const result = await checkPairingAllowed(this.runtime, {
            channel: "slack",
            senderId: `${teamId || accountId}:${userId}`,
            metadata: { accountId, teamId, userId },
          });
          return {
            allowed: result.allowed,
            ...(result.replyMessage
              ? { replyMessage: result.replyMessage }
              : {}),
          };
        },
      });
      const state: SlackAccountRuntime = {
        accountId,
        account,
        app,
        client: app.client,
        userClient,
        botUserId,
        teamId,
        policy,
        userCache: new Map(),
        channelCache: new Map(),
        isConnected: false,
      };

      this.accountStates.set(accountId, state);
      this.syncDefaultAccountAliases();

      this.runtime.logger.info(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          accountId,
          botUserId: state.botUserId,
          teamId: state.teamId,
        },
        "Slack bot authenticated",
      );

      this.registerEventHandlers(state);

      try {
        await app.start();
      } catch (error) {
        this.accountStates.delete(accountId);
        this.syncDefaultAccountAliases();
        throw error;
      }
      state.isConnected = true;
      this.syncDefaultAccountAliases();

      this.runtime.logger.info(
        { src: "plugin:slack", agentId: this.runtime.agentId, accountId },
        "Slack account started successfully",
      );

      await this.ensureWorkspaceExists(accountId);
      return state;
    })();

    this.accountStarts.set(accountId, startPromise);
    try {
      return await startPromise;
    } finally {
      this.accountStarts.delete(accountId);
    }
  }

  private async shutdown(): Promise<void> {
    const states =
      this.accountStates instanceof Map
        ? Array.from(this.accountStates.values())
        : [];
    if (states.length > 0) {
      for (const state of states) {
        await state.app.stop();
        state.isConnected = false;
        this.runtime.logger.info(
          {
            src: "plugin:slack",
            agentId: this.runtime.agentId,
            accountId: state.accountId,
          },
          "Slack account stopped",
        );
      }
      this.accountStates.clear();
      this.syncDefaultAccountAliases();
      return;
    }

    if (this.app) {
      await this.app.stop();
      this.app = null;
      this.client = null;
      this.isConnected = false;

      this.runtime.logger.info(
        { src: "plugin:slack", agentId: this.runtime.agentId },
        "Slack service stopped",
      );
    }
  }

  private registerEventHandlers(state?: SlackAccountRuntime): void {
    const app = state?.app ?? this.app;
    const accountId = state?.accountId ?? this.defaultAccountId;
    if (!app) return;

    // Handle regular messages
    app.message(async ({ message, client, body }) => {
      if (!this.isInboundWorkspaceAuthorized(accountId, body, "message")) {
        return;
      }
      await this.handleMessage(
        message as SlackMessageEventType,
        client,
        accountId,
        body,
      );
    });

    app.action(/^eliza_interaction_/, async ({ action, ack, body, client }) => {
      await ack();
      const actionRecord = action as { value?: unknown };
      const bodyRecord = body as {
        user?: { id?: unknown };
        channel?: { id?: unknown };
        message?: { ts?: unknown; thread_ts?: unknown };
      };
      const decoded = decodeCallback(actionRecord.value);
      const userId =
        typeof bodyRecord.user?.id === "string" ? bodyRecord.user.id : "";
      const channelId =
        typeof bodyRecord.channel?.id === "string" ? bodyRecord.channel.id : "";
      const messageTs =
        typeof bodyRecord.message?.ts === "string" ? bodyRecord.message.ts : "";
      if (!decoded || !userId || !channelId || !messageTs) {
        this.runtime.logger.warn(
          { src: "plugin:slack", accountId, channelId, userId },
          "Ignoring malformed Slack interaction callback",
        );
        return;
      }
      await this.handleMessage(
        {
          channel: channelId,
          user: userId,
          text: decoded.value,
          ts: messageTs,
          thread_ts:
            typeof bodyRecord.message?.thread_ts === "string"
              ? bodyRecord.message.thread_ts
              : undefined,
        } as SlackMessageEventType,
        client,
        accountId,
        body,
      );
    });

    // Handle app mentions
    app.event("app_mention", async ({ event, client, body }) => {
      if (!this.isInboundWorkspaceAuthorized(accountId, body, "app_mention")) {
        return;
      }
      await this.handleAppMention(
        event as SlackAppMentionEventType,
        client,
        accountId,
        body,
      );
    });

    // Handle reactions
    app.event("reaction_added", async ({ event, body }) => {
      if (
        !this.isInboundWorkspaceAuthorized(accountId, body, "reaction_added")
      ) {
        return;
      }
      await this.handleReaction(
        event,
        "added",
        accountId,
        extractSlackEventWorkspace(body),
      );
    });

    app.event("reaction_removed", async ({ event, body }) => {
      if (
        !this.isInboundWorkspaceAuthorized(accountId, body, "reaction_removed")
      ) {
        return;
      }
      await this.handleReaction(
        event,
        "removed",
        accountId,
        extractSlackEventWorkspace(body),
      );
    });

    // Handle channel joins/leaves
    app.event("member_joined_channel", async ({ event, body }) => {
      if (
        !this.isInboundWorkspaceAuthorized(
          accountId,
          body,
          "member_joined_channel",
        )
      ) {
        return;
      }
      await this.handleMemberJoinedChannel(event, accountId);
    });

    app.event("member_left_channel", async ({ event, body }) => {
      if (
        !this.isInboundWorkspaceAuthorized(
          accountId,
          body,
          "member_left_channel",
        )
      ) {
        return;
      }
      await this.handleMemberLeftChannel(event, accountId);
    });

    // Handle file shares
    app.event("file_shared", async ({ event, body }) => {
      if (!this.isInboundWorkspaceAuthorized(accountId, body, "file_shared")) {
        return;
      }
      await this.handleFileShared(event, accountId);
    });
  }

  private getDefaultAccountState(): SlackAccountRuntime | null {
    const states = this.accountStates;
    if (!(states instanceof Map) || states.size === 0) {
      return null;
    }
    const defaultId = normalizeAccountId(this.defaultAccountId);
    return states.get(defaultId) ?? states.values().next().value ?? null;
  }

  private getAccountState(
    accountId?: string | null,
  ): SlackAccountRuntime | null {
    const states = this.accountStates;
    if (!(states instanceof Map) || states.size === 0) {
      return null;
    }
    if (accountId) {
      return states.get(normalizeAccountId(accountId)) ?? null;
    }
    return this.getDefaultAccountState();
  }

  private getClientForAccount(accountId?: string | null): WebClient | null {
    const state = this.getAccountState(accountId);
    if (state?.client) {
      return state.client;
    }
    const requested = accountId ? normalizeAccountId(accountId) : null;
    const defaultId = normalizeAccountId(this.defaultAccountId);
    if (!requested || requested === defaultId) {
      return this.client;
    }
    return null;
  }

  /**
   * Returns the client that outbound user-action calls (currently
   * chat.postMessage) should use for the given account. OWNER-role
   * accounts with a configured xoxp- user token route through it so
   * the agent posts as the user; everything else stays on the bot
   * client. Falls back to `getClientForAccount` when no per-account
   * state has been initialised yet.
   */
  private getOutboundClient(accountId?: string | null): WebClient | null {
    const state = this.getAccountState(accountId);
    if (!state) {
      return this.getClientForAccount(accountId);
    }
    if (state.account.role === "OWNER") {
      if (state.account.config.userTokenReadOnly === true) {
        return state.client;
      }
      if (!state.userClient) {
        this.runtime.logger.warn(
          { accountId },
          "[SlackService] Account is configured as OWNER but has no userToken — falling back to bot client. Set userToken (xoxp-) to route messages as user.",
        );
      } else {
        return state.userClient;
      }
    }
    return state.client;
  }

  private getPolicyForAccount(
    accountId?: string | null,
  ): SlackAccountPolicyResolver | null {
    return this.getAccountState(accountId)?.policy ?? null;
  }

  private isInboundWorkspaceAuthorized(
    accountId: string,
    body: unknown,
    eventFamily: string,
  ): boolean {
    const policy = this.getPolicyForAccount(accountId);
    const workspace = extractSlackEventWorkspace(body);
    const reason = policy
      ? policy.workspaceDenial(workspace)
      : "workspace_identity_missing";
    if (!reason) return true;
    this.runtime.logger.warn(
      {
        src: "plugin:slack",
        agentId: this.runtime.agentId,
        accountId,
        eventFamily,
        reason,
        receivedTeamId: workspace.teamId,
      },
      "Rejected Slack event without authenticated workspace attribution",
    );
    return false;
  }

  private getUserCacheForAccount(
    accountId?: string | null,
  ): Map<string, SlackUser> {
    return this.getAccountState(accountId)?.userCache ?? this.userCache;
  }

  private getChannelCacheForAccount(
    accountId?: string | null,
  ): Map<string, SlackChannel> {
    return this.getAccountState(accountId)?.channelCache ?? this.channelCache;
  }

  private getBotUserIdForAccount(accountId?: string | null): string | null {
    return this.getAccountState(accountId)?.botUserId ?? this.botUserId;
  }

  private getTeamIdForAccount(accountId?: string | null): string | null {
    return this.getAccountState(accountId)?.teamId ?? this.teamId;
  }

  private getRegisteredAccountIds(): string[] {
    const states = this.accountStates;
    if (states instanceof Map && states.size > 0) {
      return Array.from(states.keys());
    }
    return [normalizeAccountId(this.defaultAccountId)];
  }

  private resolveAccountIdFromContext(
    context?: MessageConnectorQueryContext | null,
    target?: TargetInfo | null,
  ): string | undefined {
    const scopedTarget = target as AccountScopedTargetInfo | null | undefined;
    const scopedContext = context as
      | AccountScopedConnectorContext
      | null
      | undefined;
    return (
      scopedTarget?.accountId ??
      (scopedContext?.target as AccountScopedTargetInfo | undefined)
        ?.accountId ??
      scopedContext?.accountId ??
      scopedContext?.account?.accountId ??
      undefined
    );
  }

  private async resolveAccountIdForTarget(
    runtime: IAgentRuntime,
    target?: TargetInfo | null,
    fallback?: { accountId?: string; roomId?: UUID } | null,
  ): Promise<string> {
    const direct =
      (target as AccountScopedTargetInfo | null | undefined)?.accountId ??
      fallback?.accountId ??
      undefined;
    if (direct) {
      return normalizeAccountId(direct);
    }

    const roomId = target?.roomId ?? fallback?.roomId;
    if (roomId && typeof runtime.getRoom === "function") {
      const room = await runtime.getRoom(roomId);
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      if (
        typeof metadata?.accountId === "string" &&
        metadata.accountId.trim()
      ) {
        return normalizeAccountId(metadata.accountId);
      }
      const slack =
        metadata?.slack && typeof metadata.slack === "object"
          ? (metadata.slack as Record<string, unknown>)
          : undefined;
      if (typeof slack?.accountId === "string" && slack.accountId.trim()) {
        return normalizeAccountId(slack.accountId);
      }
    }

    return normalizeAccountId(this.defaultAccountId);
  }

  private getCandidateAccountIds(
    context?: MessageConnectorQueryContext | null,
    target?: TargetInfo | null,
  ): string[] {
    const explicit = this.resolveAccountIdFromContext(context, target);
    if (explicit) {
      return [normalizeAccountId(explicit)];
    }
    return this.getRegisteredAccountIds();
  }

  private scopedSlackKey(
    prefix: string,
    key: string,
    accountId?: string | null,
  ): string {
    const normalized = normalizeAccountId(accountId ?? this.defaultAccountId);
    return normalized === DEFAULT_ACCOUNT_ID
      ? `${prefix}-${key}`
      : `${prefix}-${normalized}-${key}`;
  }

  private buildEventPayload(accountId?: string | null): EventPayload {
    const normalized = normalizeAccountId(accountId ?? this.defaultAccountId);
    return {
      runtime: this.runtime,
      source: "slack",
      accountId: normalized,
      metadata: { accountId: normalized },
    } as EventPayload;
  }

  private async authorizeInboundEvent(
    event: Parameters<SlackAccountPolicyResolver["authorize"]>[0],
    client: WebClient,
    accountId: string,
  ): Promise<SlackInboundPolicyDecision> {
    const policy = this.getPolicyForAccount(accountId);
    let decision: SlackInboundPolicyDecision;
    try {
      decision = policy
        ? await policy.authorize(event)
        : {
            allowed: false,
            reason: "unknown_conversation" as const,
            isThread: event.isThread,
          };
    } catch (cause) {
      // error-policy:J2 Policy lookup failures stay visible to Bolt and the owner.
      const error = new ElizaError("Slack inbound policy resolution failed", {
        code: "SLACK_INBOUND_POLICY_RESOLUTION_FAILED",
        context: {
          accountId,
          channelId: event.channelId,
          userId: event.userId,
          eventType: event.eventType,
        },
        cause,
      });
      this.runtime.reportError("slack-inbound-policy", error);
      throw error;
    }

    if (decision.pairingReply) {
      await client.chat.postMessage({
        channel: event.channelId,
        text: decision.pairingReply,
      });
    }
    if (!decision.allowed) {
      this.runtime.logger.debug(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          accountId,
          channelId: event.channelId,
          userId: event.userId,
          eventType: event.eventType,
          conversationKind: decision.conversationKind,
          isThread: decision.isThread,
          reason: decision.reason,
          channelPolicyKey: decision.channelPolicyKey,
        },
        "Inbound Slack event denied by account policy",
      );
    }
    return decision;
  }

  private async handleMessage(
    message: SlackMessageEventType,
    client: WebClient,
    accountId = this.defaultAccountId,
    body?: unknown,
  ): Promise<void> {
    if (
      !isValidChannelId(message.channel) ||
      !isValidMessageTs(message.ts) ||
      (message.user !== undefined && !isValidUserId(message.user)) ||
      (!message.user && !message.bot_id)
    ) {
      this.runtime.logger.warn(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          accountId,
          channelId: message.channel,
          messageTs: message.ts,
          userId: message.user,
        },
        "Ignoring malformed Slack message event",
      );
      return;
    }

    const botUserId = this.getBotUserIdForAccount(accountId);

    // Ignore messages from self
    if (message.user === botUserId) {
      return;
    }

    const isMentioned = Boolean(message.text?.includes(`<@${botUserId}>`));
    const workspace = extractSlackEventWorkspace(body);
    const gate = await this.authorizeInboundEvent(
      {
        eventType: "message",
        channelId: message.channel,
        userId: message.user ?? message.bot_id ?? "",
        channelType: message.channel_type,
        subtype: message.subtype,
        isThread: Boolean(
          message.thread_ts && message.thread_ts !== message.ts,
        ),
        isMentioned,
        isBotMessage: Boolean(message.bot_id),
        ...workspace,
      },
      client,
      accountId,
    );
    if (!gate.allowed) return;
    // Public/private mentions also arrive on app_mention. Arbitration happens
    // after classification so a missing channel_type cannot create two lanes.
    if (
      isMentioned &&
      (gate.conversationKind === "public_channel" ||
        gate.conversationKind === "private_channel")
    ) {
      return;
    }

    const _isThreadReply = Boolean(
      message.thread_ts && message.thread_ts !== message.ts,
    );

    // Build memory from message
    const memory = await this.buildMemoryFromMessage(message, accountId);
    if (!memory) return;

    // Get or create room
    const room = await this.ensureRoomExists(
      message.channel,
      message.thread_ts,
      accountId,
    );

    const existingEntity = await this.runtime.getEntityById(memory.entityId);
    if (!existingEntity) {
      const slackUserId = message.user ?? memory.entityId;
      const user = message.user
        ? await this.getUser(message.user, accountId)
        : null;
      const displayName = user ? getSlackUserDisplayName(user) : slackUserId;
      await this.runtime.createEntity({
        id: memory.entityId,
        names: [displayName],
        metadata: {
          source: "slack",
          accountId,
          slack: {
            accountId,
            id: slackUserId,
            name: displayName,
            userName: user?.name || slackUserId,
          },
        },
        agentId: this.runtime.agentId,
      });
    }

    const claimedMemory = await this.claimInboundMemory(
      memory,
      "message",
      message.ts,
      accountId,
      workspace,
      body,
    );
    if (!claimedMemory) return;

    // Emit event
    await this.runtime.emitEvent(
      SlackEventTypes.MESSAGE_RECEIVED as string,
      this.buildEventPayload(accountId),
    );

    // Process the message through the agent
    await this.processAgentMessage(
      claimedMemory,
      room,
      message.channel,
      message.thread_ts || message.ts,
      accountId,
    );
  }

  private async handleAppMention(
    event: SlackAppMentionEventType,
    client: WebClient,
    accountId = this.defaultAccountId,
    body?: unknown,
  ): Promise<void> {
    if (
      !event.user ||
      !isValidUserId(event.user) ||
      !isValidChannelId(event.channel) ||
      !isValidMessageTs(event.ts)
    ) {
      this.runtime.logger.warn(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          accountId,
          channelId: event.channel,
          messageTs: event.ts,
          userId: event.user,
        },
        "Ignoring malformed Slack app mention event",
      );
      return;
    }

    const workspace = extractSlackEventWorkspace(body);
    const gate = await this.authorizeInboundEvent(
      {
        eventType: "app_mention",
        channelId: event.channel,
        userId: event.user,
        isThread: Boolean(event.thread_ts && event.thread_ts !== event.ts),
        isMentioned: true,
        isBotMessage: false,
        ...workspace,
      },
      client,
      accountId,
    );
    if (!gate.allowed) return;

    // Build memory from mention
    const memory = await this.buildMemoryFromMention(
      {
        user: event.user,
        text: event.text,
        channel: event.channel,
        ts: event.ts,
        thread_ts: event.thread_ts,
      },
      accountId,
    );
    if (!memory) return;

    // Get or create room
    const room = await this.ensureRoomExists(
      event.channel,
      event.thread_ts,
      accountId,
    );

    const existingEntity = await this.runtime.getEntityById(memory.entityId);
    if (!existingEntity) {
      const user = await this.getUser(event.user, accountId);
      const displayName = user ? getSlackUserDisplayName(user) : event.user;
      await this.runtime.createEntity({
        id: memory.entityId,
        names: [displayName],
        metadata: {
          source: "slack",
          accountId,
          slack: {
            accountId,
            id: event.user,
            name: displayName,
            userName: user?.name || event.user,
          },
        },
        agentId: this.runtime.agentId,
      });
    }

    const claimedMemory = await this.claimInboundMemory(
      memory,
      "app_mention",
      event.ts,
      accountId,
      workspace,
      body,
    );
    if (!claimedMemory) return;

    // Emit event
    await this.runtime.emitEvent(
      SlackEventTypes.APP_MENTION as string,
      this.buildEventPayload(accountId),
    );

    // Process the message
    await this.processAgentMessage(
      claimedMemory,
      room,
      event.channel,
      event.thread_ts || event.ts,
      accountId,
    );
  }

  private async claimInboundMemory(
    memory: Memory,
    eventFamily: "message" | "app_mention",
    recordId: string,
    accountId: string,
    workspace: { teamId?: string; enterpriseId?: string },
    body: unknown,
  ): Promise<Memory | null> {
    if (!memory.id || !workspace.teamId) {
      throw new ElizaError("Slack inbound claim identity is incomplete", {
        code: "SLACK_INBOUND_CLAIM_IDENTITY_MISSING",
        context: {
          accountId,
          eventFamily,
          hasMemoryId: Boolean(memory.id),
          hasTeamId: Boolean(workspace.teamId),
        },
      });
    }

    const claim: SlackInboundClaim = {
      accountId,
      teamId: workspace.teamId,
      ...(workspace.enterpriseId
        ? { enterpriseId: workspace.enterpriseId }
        : {}),
      eventId: extractSlackDeliveryEventId(body, `${eventFamily}:${recordId}`),
      recordId,
      token: globalThis.crypto.randomUUID(),
    };
    const claimedMemory: Memory = {
      ...memory,
      metadata: {
        ...(memory.metadata as MessageMetadata | undefined),
        type: "message",
        slackInboundClaim: claim,
      } satisfies MessageMetadata,
    };

    // The stable memory primary key is the durable admission lock. SQL uses
    // INSERT ... ON CONFLICT DO NOTHING; reading back the per-attempt token
    // makes the created-versus-existing result explicit without a racy
    // preflight read. A retry observes the winner's token and fails closed.
    await this.runtime.createMemory(claimedMemory, "messages");
    const persisted = await this.runtime.getMemoryById(memory.id);
    const persistedClaim = readSlackInboundClaim(persisted);
    if (persistedClaim?.token !== claim.token) {
      this.runtime.logger.debug(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          accountId,
          teamId: workspace.teamId,
          eventId: claim.eventId,
          recordId,
          eventFamily,
        },
        "Ignoring duplicate Slack inbound delivery",
      );
      return null;
    }
    return claimedMemory;
  }

  private async handleReaction(
    rawEvent: unknown,
    action: "added" | "removed",
    accountId: string,
    workspace: { teamId?: string; enterpriseId?: string },
  ): Promise<void> {
    const event = this.parseReactionEvent(rawEvent);
    if (!event) return;

    const policy = this.getPolicyForAccount(accountId);
    let decision: SlackInboundPolicyDecision;
    try {
      decision = policy
        ? await policy.authorizeReaction(
            {
              eventType: "reaction",
              channelId: event.item.channel,
              userId: event.user,
              isThread: false,
              isMentioned: true,
              isBotMessage:
                event.user === this.getBotUserIdForAccount(accountId),
              ...workspace,
            },
            event.reaction,
          )
        : {
            allowed: false,
            reason: "unknown_conversation",
            isThread: false,
          };
    } catch (cause) {
      // error-policy:J2 Policy lookup failures stay visible to Bolt and the owner.
      const error = new ElizaError("Slack reaction policy resolution failed", {
        code: "SLACK_REACTION_POLICY_RESOLUTION_FAILED",
        context: {
          accountId,
          channelId: event.item.channel,
          userId: event.user,
        },
        cause,
      });
      this.runtime.reportError("slack-inbound-policy", error);
      throw error;
    }
    if (!decision.allowed) {
      this.runtime.logger.debug(
        {
          src: "plugin:slack",
          agentId: this.runtime.agentId,
          accountId,
          action,
          channelId: event.item.channel,
          userId: event.user,
          reaction: event.reaction,
          reason: decision.reason,
          conversationKind: decision.conversationKind,
        },
        "Inbound Slack reaction denied by account policy",
      );
      return;
    }

    try {
      const target = await this.findReactionTargetMemory(event, accountId);
      if (!target?.id) {
        this.runtime.logger.warn(
          {
            src: "plugin:slack",
            agentId: this.runtime.agentId,
            accountId,
            channelId: event.item.channel,
            messageTs: event.item.ts,
          },
          "Rejected Slack reaction because its message lane is unknown",
        );
        return;
      }
      if (
        !policy?.isReactionTargetAllowed(
          target.entityId === this.runtime.agentId,
        )
      ) {
        this.runtime.logger.debug(
          {
            src: "plugin:slack",
            agentId: this.runtime.agentId,
            accountId,
            action,
            channelId: event.item.channel,
            userId: event.user,
            reaction: event.reaction,
            reason: "reaction_not_owned",
          },
          "Inbound Slack reaction denied by account policy",
        );
        return;
      }

      const entityId = this.getEntityId(event.user, accountId);
      const existingEntity = await this.runtime.getEntityById(entityId);
      if (!existingEntity) {
        await this.runtime.createEntity({
          id: entityId,
          names: [event.user],
          agentId: this.runtime.agentId,
          metadata: {
            source: "slack",
            accountId,
            slack: { accountId, id: event.user, userId: event.user },
          },
        });
      }

      const timestamp = this.parseSlackTimestamp(event.event_ts);
      const threadTs = this.readSlackThreadTs(target);
      const reactionMemory: Memory = {
        id: createUniqueUuid(
          this.runtime,
          this.scopedSlackKey(
            "slack-reaction",
            [
              workspace.teamId,
              event.item.channel,
              event.item.ts,
              event.user,
              event.reaction,
              action,
              event.event_ts,
            ].join(":"),
            accountId,
          ),
        ),
        agentId: this.runtime.agentId,
        roomId: target.roomId,
        entityId,
        content: {
          text: `${action === "added" ? "Added" : "Removed"} :${event.reaction}:`,
          source: "slack",
          name: event.user,
          inReplyTo: target.id,
          metadata: { accountId },
        },
        metadata: {
          type: "message",
          source: "slack",
          provider: "slack",
          accountId,
          timestamp,
          entityName: event.user,
          entityUserName: event.user,
          fromBot: false,
          fromId: event.user,
          sourceId: entityId,
          slackReaction: {
            action,
            emoji: event.reaction,
            channelId: event.item.channel,
            targetMessageTs: event.item.ts,
            targetMessageId: target.id,
            itemUser: event.item_user,
          },
          slack: {
            accountId,
            teamId: workspace.teamId,
            channelId: event.item.channel,
            userId: event.user,
            messageId: event.item.ts,
            threadTs,
          },
          slackChannelId: event.item.channel,
          slackMessageTs: event.item.ts,
          slackThreadTs: threadTs,
        } satisfies Memory["metadata"],
        createdAt: timestamp,
      };
      const payload: SlackReactionPayload & MessagePayload = {
        ...this.buildEventPayload(accountId),
        message: reactionMemory,
        reaction: event.reaction,
        userId: event.user,
        channelId: event.item.channel,
        messageTs: event.item.ts,
        itemUser: event.item_user,
      };
      await this.runtime.emitEvent(
        action === "added"
          ? [SlackEventTypes.REACTION_ADDED, EventType.REACTION_RECEIVED]
          : SlackEventTypes.REACTION_REMOVED,
        payload,
      );
    } catch (cause) {
      // error-policy:J2 Bolt automatically acknowledges Events API traffic, so failures must reach owner diagnostics.
      const error = new ElizaError("Slack reaction bridge failed", {
        code: "SLACK_REACTION_BRIDGE_FAILED",
        context: {
          accountId,
          action,
          channelId: event.item.channel,
          userId: event.user,
          messageTs: event.item.ts,
        },
        cause,
      });
      this.runtime.reportError("slack-reaction-bridge", error);
      throw error;
    }
  }

  private parseReactionEvent(rawEvent: unknown): SlackReactionEventType | null {
    if (!isUnknownRecord(rawEvent)) return null;
    const item = isUnknownRecord(rawEvent.item) ? rawEvent.item : null;
    const user = typeof rawEvent.user === "string" ? rawEvent.user : "";
    const reaction =
      typeof rawEvent.reaction === "string" ? rawEvent.reaction : "";
    const channel = typeof item?.channel === "string" ? item.channel : "";
    const messageTs = typeof item?.ts === "string" ? item.ts : "";
    const eventTs =
      typeof rawEvent.event_ts === "string" ? rawEvent.event_ts : "";
    const itemUser =
      typeof rawEvent.item_user === "string" ? rawEvent.item_user : undefined;
    const valid =
      isValidUserId(user) &&
      isValidSlackEmojiName(reaction) &&
      item?.type === "message" &&
      isValidChannelId(channel) &&
      isValidMessageTs(messageTs) &&
      isValidMessageTs(eventTs) &&
      (rawEvent.item_user === undefined ||
        (itemUser !== undefined && isValidUserId(itemUser)));
    if (!valid) {
      this.runtime.logger.warn(
        { src: "plugin:slack", agentId: this.runtime.agentId },
        "Rejected malformed Slack reaction event",
      );
      return null;
    }
    return {
      user,
      reaction: reaction.toLowerCase(),
      item: { type: "message", channel, ts: messageTs },
      ...(itemUser ? { item_user: itemUser } : {}),
      event_ts: eventTs,
    };
  }

  private async findReactionTargetMemory(
    event: SlackReactionEventType,
    accountId: string,
  ): Promise<Memory | null> {
    const ids = [
      createUniqueUuid(
        this.runtime,
        this.scopedSlackKey(
          "slack",
          `${event.item.channel}-${event.item.ts}`,
          accountId,
        ),
      ),
      createUniqueUuid(
        this.runtime,
        this.scopedSlackKey(
          "slack-mention",
          `${event.item.channel}-${event.item.ts}`,
          accountId,
        ),
      ),
      // Legacy inbound rows omitted the channel from their IDs. Keep these
      // fallbacks for existing installations while preferring unambiguous IDs.
      createUniqueUuid(
        this.runtime,
        this.scopedSlackKey("slack", event.item.ts, accountId),
      ),
      createUniqueUuid(
        this.runtime,
        this.scopedSlackKey("slack-mention", event.item.ts, accountId),
      ),
    ];
    const candidates = (
      await Promise.all(ids.map((id) => this.runtime.getMemoryById(id)))
    ).filter((memory): memory is Memory => Boolean(memory));
    if (candidates.length === 0) return null;
    const rooms = new Set(candidates.map((memory) => memory.roomId));
    if (rooms.size > 1) {
      throw new ElizaError("Slack reaction target resolved to multiple rooms", {
        code: "SLACK_REACTION_TARGET_AMBIGUOUS",
        context: {
          accountId,
          channelId: event.item.channel,
          messageTs: event.item.ts,
          roomIds: Array.from(rooms),
        },
      });
    }
    const botUserId = this.getBotUserIdForAccount(accountId);
    return (
      candidates.find(
        (memory) =>
          event.item_user === botUserId &&
          memory.entityId === this.runtime.agentId,
      ) ?? candidates[0]
    );
  }

  private readSlackThreadTs(memory: Memory): string | undefined {
    const metadata = memory.metadata;
    if (!metadata || !("slackThreadTs" in metadata)) return undefined;
    return typeof metadata.slackThreadTs === "string"
      ? metadata.slackThreadTs
      : undefined;
  }

  private async handleMemberJoinedChannel(
    event: {
      user: string;
      channel: string;
      team?: string;
    },
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (event.user === this.getBotUserIdForAccount(accountId)) {
      const policy = this.getPolicyForAccount(accountId);
      const admitted = policy
        ? await policy.registerBotJoin(event.channel)
        : false;
      if (admitted) {
        await this.ensureRoomExists(event.channel, undefined, accountId);
      }
    }

    await this.runtime.emitEvent(
      SlackEventTypes.MEMBER_JOINED_CHANNEL as string,
      this.buildEventPayload(accountId),
    );
  }

  private async handleMemberLeftChannel(
    event: {
      user: string;
      channel: string;
      team?: string;
    },
    accountId = this.defaultAccountId,
  ): Promise<void> {
    if (event.user === this.getBotUserIdForAccount(accountId)) {
      this.getPolicyForAccount(accountId)?.registerBotLeave(event.channel);
    }

    await this.runtime.emitEvent(
      SlackEventTypes.MEMBER_LEFT_CHANNEL as string,
      this.buildEventPayload(accountId),
    );
  }

  private async handleFileShared(
    _event: {
      file_id: string;
      user_id: string;
      channel_id: string;
    },
    accountId = this.defaultAccountId,
  ): Promise<void> {
    await this.runtime.emitEvent(
      SlackEventTypes.FILE_SHARED as string,
      this.buildEventPayload(accountId),
    );
  }

  private isChannelAllowed(
    channelId: string,
    accountId?: string | null,
  ): boolean {
    return (
      this.getPolicyForAccount(accountId)?.isChannelAllowed(channelId) ?? false
    );
  }

  private async processAgentMessage(
    memory: Memory,
    room: Room,
    channelId: string,
    threadTs: string,
    accountId = this.defaultAccountId,
  ): Promise<void> {
    const callback: HandlerCallback = async (
      response: Content,
    ): Promise<Memory[]> => {
      const responseText = response.text || "";
      if (!responseText.trim()) {
        this.runtime.logger.warn(
          { src: "plugin:slack", channelId, roomId: room.id },
          "Empty response from model, skipping sendMessage",
        );
        return [];
      }

      const sent = await this.sendMessage(
        channelId,
        responseText,
        {
          threadTs,
          replyBroadcast: undefined,
          unfurlLinks: undefined,
          unfurlMedia: undefined,
          mrkdwn: undefined,
          attachments: undefined,
          blocks: undefined,
        },
        accountId,
      );

      const responseRoom = await this.ensureRoomExists(
        channelId,
        threadTs,
        accountId,
      );
      const responseMemories: Memory[] = sent.messages.map(
        ({ ts, text: sentText }) => ({
          id: createUniqueUuid(
            this.runtime,
            this.scopedSlackKey("slack", `${channelId}-${ts}`, accountId),
          ),
          agentId: this.runtime.agentId,
          roomId: responseRoom.id,
          entityId: this.runtime.agentId,
          content: {
            text: sentText,
            source: "slack",
            inReplyTo: memory.id,
            metadata: { accountId },
          },
          metadata: {
            type: "message",
            source: "slack",
            provider: "slack",
            accountId,
            timestamp: this.parseSlackTimestamp(ts),
            fromBot: true,
            fromId: this.runtime.agentId,
            sourceId: this.runtime.agentId,
            messageIdFull: ts,
            slack: {
              accountId,
              teamId: this.getTeamIdForAccount(accountId) ?? undefined,
              channelId,
              userId: this.getBotUserIdForAccount(accountId) ?? undefined,
              messageId: ts,
              threadTs,
            },
            slackChannelId: channelId,
            slackMessageTs: ts,
            slackThreadTs: threadTs,
          } satisfies Memory["metadata"],
          createdAt: this.parseSlackTimestamp(ts),
        }),
      );

      for (const responseMemory of responseMemories) {
        await this.runtime.createMemory(responseMemory, "messages");
      }

      await this.runtime.emitEvent(
        SlackEventTypes.MESSAGE_SENT as string,
        this.buildEventPayload(accountId),
      );

      return responseMemories;
    };

    const messageService = getMessageService(this.runtime);
    if (messageService) {
      await messageService.handleMessage(this.runtime, memory, callback);
    }
  }

  private async buildMemoryFromMessage(
    message: SlackMessageEventType,
    accountId = this.defaultAccountId,
  ): Promise<Memory | null> {
    const senderId = message.user ?? message.bot_id;
    if (!senderId) return null;

    const roomId = await this.getRoomId(
      message.channel,
      message.thread_ts,
      accountId,
    );
    const entityId = this.getEntityId(senderId, accountId);

    // Get user info for display name
    const user = message.user
      ? await this.getUser(message.user, accountId)
      : null;
    const displayName = user ? getSlackUserDisplayName(user) : senderId;

    // Extract media from files
    const media: Media[] = [];
    if ("files" in message && message.files) {
      for (const file of message.files) {
        media.push({
          id: file.id,
          url: file.urlPrivate,
          title: file.title || file.name,
          source: "slack",
          description: file.name,
        });
      }
    }

    const memory: Memory = {
      id: createUniqueUuid(
        this.runtime,
        this.scopedSlackKey(
          "slack",
          `${message.channel}-${message.ts}`,
          accountId,
        ),
      ),
      agentId: this.runtime.agentId,
      roomId,
      entityId,
      content: {
        text: message.text || "",
        source: "slack",
        name: displayName,
        metadata: { accountId },
        ...(media.length > 0 ? { attachments: media } : {}),
      },
      metadata: {
        type: "message",
        source: "slack",
        provider: "slack",
        accountId,
        timestamp: this.parseSlackTimestamp(message.ts),
        entityName: displayName,
        entityUserName: user?.name ?? senderId,
        fromBot: Boolean(message.bot_id),
        fromId: senderId,
        sourceId: entityId,
        chatType: message.channel_type,
        messageIdFull: message.ts,
        sender: {
          id: senderId,
          name: displayName,
          username: user?.name ?? senderId,
        },
        slack: {
          accountId,
          teamId: this.getTeamIdForAccount(accountId) ?? undefined,
          channelId: message.channel,
          userId: senderId,
          messageId: message.ts,
          threadTs: message.thread_ts,
        },
        slackChannelId: message.channel,
        slackMessageTs: message.ts,
        slackThreadTs: message.thread_ts,
      } satisfies Memory["metadata"],
      createdAt: this.parseSlackTimestamp(message.ts),
    };

    return memory;
  }

  private async buildMemoryFromMention(
    event: {
      user: string;
      text: string;
      channel: string;
      ts: string;
      thread_ts?: string;
    },
    accountId = this.defaultAccountId,
  ): Promise<Memory | null> {
    const roomId = await this.getRoomId(
      event.channel,
      event.thread_ts,
      accountId,
    );
    const entityId = this.getEntityId(event.user, accountId);

    const user = await this.getUser(event.user, accountId);
    const displayName = user ? getSlackUserDisplayName(user) : event.user;

    // Remove the bot mention from the text
    const cleanText = event.text
      .replace(`<@${this.getBotUserIdForAccount(accountId)}>`, "")
      .trim();

    const memory: Memory = {
      id: createUniqueUuid(
        this.runtime,
        this.scopedSlackKey(
          "slack-mention",
          `${event.channel}-${event.ts}`,
          accountId,
        ),
      ),
      agentId: this.runtime.agentId,
      roomId,
      entityId,
      content: {
        text: cleanText,
        source: "slack",
        name: displayName,
        metadata: { accountId },
        mentionContext: { isMention: true, isReply: false, isThread: false },
      },
      metadata: {
        type: "message",
        source: "slack",
        provider: "slack",
        accountId,
        timestamp: this.parseSlackTimestamp(event.ts),
        entityName: displayName,
        entityUserName: user?.name ?? event.user,
        fromBot: false,
        fromId: event.user,
        sourceId: entityId,
        messageIdFull: event.ts,
        slack: {
          accountId,
          teamId: this.getTeamIdForAccount(accountId) ?? undefined,
          channelId: event.channel,
          userId: event.user,
          messageId: event.ts,
          threadTs: event.thread_ts,
        },
        slackChannelId: event.channel,
        slackMessageTs: event.ts,
        slackThreadTs: event.thread_ts,
      } satisfies Memory["metadata"],
      createdAt: this.parseSlackTimestamp(event.ts),
    };

    return memory;
  }

  private async getRoomId(
    channelId: string,
    threadTs?: string,
    accountId?: string | null,
  ): Promise<UUID> {
    // Use thread_ts to create unique rooms for threads
    const roomKey = threadTs ? `${channelId}-${threadTs}` : channelId;
    return createUniqueUuid(
      this.runtime,
      this.scopedSlackKey("slack-room", roomKey, accountId),
    );
  }

  private getEntityId(userId: string, accountId?: string | null): UUID {
    return stringToUuid(this.scopedSlackKey("slack-user", userId, accountId));
  }

  private parseSlackTimestamp(ts: string): number {
    // Slack timestamps are in the format: 1234567890.123456
    const [seconds] = ts.split(".");
    return parseInt(seconds, 10) * 1000;
  }

  private async ensureWorkspaceExists(
    accountId = this.defaultAccountId,
  ): Promise<void> {
    const teamId = this.getTeamIdForAccount(accountId);
    const client = this.getClientForAccount(accountId);
    if (!teamId || !client) return;

    const worldId = createUniqueUuid(
      this.runtime,
      this.scopedSlackKey("slack-workspace", teamId, accountId),
    );

    const existingWorld = await this.runtime.getWorld(worldId);
    if (existingWorld) return;

    // Get team info
    const teamInfo = await client.team.info();
    const team = teamInfo.team;

    const world: World = {
      id: worldId,
      name: (team as { name?: string })?.name || `Slack Workspace ${teamId}`,
      agentId: this.runtime.agentId,
      metadata: {
        type: "slack",
        source: "slack",
        accountId,
        extra: {
          accountId,
          teamId,
          domain: (team as { domain?: string })?.domain,
        },
      },
    };

    await this.runtime.createWorld(world);

    this.runtime.logger.info(
      {
        src: "plugin:slack",
        agentId: this.runtime.agentId,
        accountId,
        worldId,
        teamId,
      },
      "Created Slack workspace world",
    );
  }

  private async ensureRoomExists(
    channelId: string,
    threadTs?: string,
    accountId = this.defaultAccountId,
  ): Promise<Room> {
    const roomId = await this.getRoomId(channelId, threadTs, accountId);

    const existingRoom = await this.runtime.getRoom(roomId);
    if (existingRoom) return existingRoom;

    // Get channel info
    const channel = await this.getChannel(channelId, accountId);
    const channelType = channel ? getSlackChannelType(channel) : "channel";
    const teamId = this.getTeamIdForAccount(accountId);

    const worldId = teamId
      ? createUniqueUuid(
          this.runtime,
          this.scopedSlackKey("slack-workspace", teamId, accountId),
        )
      : undefined;

    const elizaChannelType =
      channelType === "im"
        ? ChannelType.DM
        : channelType === "mpim"
          ? ChannelType.GROUP
          : ChannelType.GROUP;

    const room: Room = {
      id: roomId,
      name: channel?.name || channelId,
      agentId: this.runtime.agentId,
      source: "slack",
      type: elizaChannelType,
      channelId,
      worldId,
      metadata: {
        source: "slack",
        accountId,
        slackChannelType: channelType,
        threadTs,
        topic: channel?.topic?.value,
        purpose: channel?.purpose?.value,
        serverId: teamId,
        slack: {
          accountId,
          teamId,
          channelId,
          threadTs,
        },
      },
    };

    await this.runtime.createRoom(room);

    this.runtime.logger.debug(
      {
        src: "plugin:slack",
        agentId: this.runtime.agentId,
        accountId,
        roomId,
        channelId,
        threadTs,
      },
      "Created Slack room",
    );

    return room;
  }

  private buildConnectorChannelTarget(
    channel: SlackChannel,
    score = 0.5,
    accountId = this.defaultAccountId,
  ): MessageConnectorTarget | null {
    if (!channel.id || channel.isArchived) {
      return null;
    }
    if (!this.isChannelAllowed(channel.id, accountId)) {
      return null;
    }

    const kind = channel.isIm ? "user" : channel.isMpim ? "group" : "channel";
    const label = channel.name ? `#${channel.name}` : channel.id;
    const teamId = this.getTeamIdForAccount(accountId);
    return {
      target: {
        source: "slack",
        accountId,
        channelId: channel.id,
        serverId: teamId ?? undefined,
      } as TargetInfo,
      label,
      kind,
      description: channel.purpose?.value || channel.topic?.value || label,
      score,
      contexts: ["social", "connectors"],
      metadata: {
        accountId,
        slackChannelId: channel.id,
        slackTeamId: teamId,
        slackChannelType: getSlackChannelType(channel),
        channelName: channel.name,
        isPrivate: channel.isPrivate,
        isMember: channel.isMember,
        topic: channel.topic?.value,
        purpose: channel.purpose?.value,
      },
    };
  }

  private buildConnectorUserTarget(
    user: SlackUser,
    score = 0.5,
    accountId = this.defaultAccountId,
  ): MessageConnectorTarget | null {
    if (!user.id || user.deleted || user.isBot || user.isAppUser) {
      return null;
    }
    const label = getSlackUserDisplayName(user);
    return {
      target: {
        source: "slack",
        accountId,
        entityId: user.id as UUID,
        serverId:
          user.teamId ?? this.getTeamIdForAccount(accountId) ?? undefined,
      } as TargetInfo,
      label: `@${label}`,
      kind: "user",
      description: user.profile.title || "Slack user",
      score,
      contexts: ["social", "connectors"],
      metadata: {
        accountId,
        slackUserId: user.id,
        slackTeamId: user.teamId ?? this.getTeamIdForAccount(accountId),
        slackName: user.name,
        slackRealName: user.realName,
        slackDisplayName: user.profile.displayName,
        email: user.profile.email,
      },
    };
  }

  private dedupeConnectorTargets(
    targets: MessageConnectorTarget[],
  ): MessageConnectorTarget[] {
    const byKey = new Map<string, MessageConnectorTarget>();
    for (const target of targets) {
      const key = [
        (target.target as AccountScopedTargetInfo).accountId ?? "",
        target.kind ?? "target",
        target.target.channelId ?? "",
        target.target.entityId ?? "",
        target.target.threadId ?? "",
      ].join(":");
      const existing = byKey.get(key);
      if (!existing || (target.score ?? 0) > (existing.score ?? 0)) {
        byKey.set(key, target);
      }
    }
    return Array.from(byKey.values()).sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0),
    );
  }

  private async resolveSlackTargetUserId(
    runtime: IAgentRuntime,
    entityId: string,
    accountId?: string | null,
  ): Promise<string | null> {
    if (SLACK_USER_ID_PATTERN.test(entityId)) {
      return entityId;
    }

    const entity =
      typeof runtime.getEntityById === "function"
        ? await runtime.getEntityById(entityId as UUID)
        : null;
    const metadataUserId = extractSlackUserIdFromMetadata(
      entity?.metadata,
      accountId,
    );
    if (metadataUserId) {
      return metadataUserId;
    }

    if (typeof runtime.getRelationships !== "function") {
      return null;
    }

    const relationships = await runtime.getRelationships({
      entityIds: [entityId as UUID],
      tags: ["identity_link"],
    });
    for (const relationship of relationships) {
      const linkedEntityId =
        relationship.sourceEntityId === entityId
          ? relationship.targetEntityId
          : relationship.targetEntityId === entityId
            ? relationship.sourceEntityId
            : null;
      if (!linkedEntityId || linkedEntityId === entityId) {
        continue;
      }
      const linkedEntity =
        typeof runtime.getEntityById === "function"
          ? await runtime.getEntityById(linkedEntityId as UUID)
          : null;
      const linkedUserId = extractSlackUserIdFromMetadata(
        linkedEntity?.metadata,
        accountId,
      );
      if (linkedUserId) {
        return linkedUserId;
      }
    }

    return null;
  }

  private async openDirectMessageChannel(
    userId: string,
    accountId?: string | null,
  ): Promise<string> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }
    const result = await client.conversations.open({ users: userId });
    const channel = result.channel as { id?: string } | undefined;
    if (!channel?.id) {
      throw new Error(`Could not open Slack DM channel for user ${userId}`);
    }
    return channel.id;
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    const accountId = await this.resolveAccountIdForTarget(runtime, target);
    if (!this.getClientForAccount(accountId)) {
      throw new Error("Slack client not initialized");
    }

    const interactionPayload = buildSlackInteractionPayload(runtime, content);
    const text = interactionPayload.text.trim();
    const outboundAttachments = Array.isArray(content.attachments)
      ? content.attachments.filter((media) => Boolean(media?.url))
      : [];
    if (!text && outboundAttachments.length === 0) {
      throw new Error(
        "Slack SendHandler requires non-empty text or at least one attachment.",
      );
    }

    let channelId = target.channelId;
    let threadTs = target.threadId;

    if (target.roomId && (!channelId || !threadTs)) {
      const room = await runtime.getRoom(target.roomId);
      channelId = channelId ?? room?.channelId;
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      const metadataThreadTs =
        typeof metadata?.threadTs === "string" ? metadata.threadTs : undefined;
      threadTs = threadTs ?? metadataThreadTs;
    }

    if (channelId && SLACK_USER_ID_PATTERN.test(channelId)) {
      channelId = await this.openDirectMessageChannel(channelId, accountId);
    }

    if (!channelId && target.entityId) {
      const slackUserId = await this.resolveSlackTargetUserId(
        runtime,
        String(target.entityId),
        accountId,
      );
      if (!slackUserId) {
        throw new Error(
          `Could not resolve Slack user ID for entity ${target.entityId}`,
        );
      }
      channelId = await this.openDirectMessageChannel(slackUserId, accountId);
    }

    if (!channelId) {
      throw new Error(
        "Slack SendHandler requires channelId, roomId, or entityId.",
      );
    }

    if (text || interactionPayload.blocks.length > 0) {
      try {
        await this.sendMessage(
          channelId,
          text || "Choose an option.",
          {
            threadTs,
            replyBroadcast: undefined,
            unfurlLinks: undefined,
            unfurlMedia: undefined,
            mrkdwn: undefined,
            attachments: undefined,
            blocks:
              interactionPayload.blocks.length > 0
                ? interactionPayload.blocks
                : undefined,
          },
          accountId,
        );
      } catch (cause) {
        if (interactionPayload.blocks.length === 0) throw cause;
        // error-policy:J2 Preserve provider rejection while identifying the
        // interaction-specific delivery boundary for an actionable fallback.
        throw new ElizaError("Slack rejected the native interaction payload.", {
          code: "SLACK_INTERACTION_PROVIDER_REJECTED",
          context: {
            accountId,
            channelId,
            outcome: interactionPayload.outcome,
          },
          cause,
        });
      }
    }

    if (outboundAttachments.length > 0) {
      await this.sendOutboundAttachments(
        channelId,
        outboundAttachments,
        threadTs,
        accountId,
      );
    }
  }

  /**
   * Fetch an attachment's bytes through the SSRF-guarded media fetcher. Wrapped
   * as an instance method so it can be stubbed in unit tests without mocking the
   * whole runtime/network stack.
   */
  protected async fetchAttachmentBytes(
    url: string,
  ): Promise<{ buffer: Buffer; fileName?: string; contentType?: string }> {
    return resolveAttachmentBytes(url);
  }

  /**
   * Upload agent-generated `Media` attachments to a Slack channel (#8876).
   * Slack's API takes file BYTES (not a URL), so each attachment is fetched
   * through the SSRF-guarded fetcher and uploaded via {@link uploadFile}. Each
   * upload is isolated in try/catch so a single unreachable/oversized URL logs a
   * warning and never drops the rest of the reply (the text already went out).
   */
  private async sendOutboundAttachments(
    channelId: string,
    attachments: Media[],
    threadTs: string | undefined,
    accountId: string | null,
  ): Promise<void> {
    for (const media of attachments) {
      if (!media.url) continue;
      try {
        const { buffer, fileName } = await this.fetchAttachmentBytes(media.url);
        const filename =
          media.filename ?? media.title ?? fileName ?? "attachment";
        await this.uploadFile(
          channelId,
          buffer,
          filename,
          { title: media.title, threadTs },
          accountId,
        );
      } catch (error) {
        this.runtime.logger.warn(
          {
            src: "plugin:slack",
            agentId: this.runtime.agentId,
            url: media.url,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to send Slack outbound attachment; skipping",
        );
      }
    }
  }

  async resolveConnectorTargets(
    query: string,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const normalizedQuery = normalizeSlackConnectorQuery(query);
    const targets: MessageConnectorTarget[] = [];
    const accountIds = this.getCandidateAccountIds(context, context.target);

    for (const accountId of accountIds) {
      const client = this.getClientForAccount(accountId);
      if (!client) {
        continue;
      }

      try {
        const channels = await this.listChannels(
          {
            types: "public_channel,private_channel,mpim,im",
            limit: 1000,
          },
          accountId,
        );
        for (const channel of channels) {
          const score = scoreSlackConnectorMatch(normalizedQuery, channel.id, [
            channel.name,
            channel.topic?.value,
            channel.purpose?.value,
          ]);
          if (score <= 0) {
            continue;
          }
          const target = this.buildConnectorChannelTarget(
            channel,
            score,
            accountId,
          );
          if (target) {
            targets.push(target);
          }
        }
      } catch (error) {
        this.runtime.logger.debug(
          {
            src: "plugin:slack",
            agentId: this.runtime.agentId,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Slack connector channel query failed",
        );
      }

      try {
        const usersResult = await client.users.list({ limit: 200 });
        const members = (usersResult.members ?? []) as SlackApiUserMember[];
        for (const member of members) {
          const user: SlackUser = {
            id: member.id ?? "",
            teamId: member.team_id,
            name: member.name ?? "",
            deleted: Boolean(member.deleted),
            realName: member.real_name,
            tz: member.tz,
            tzLabel: member.tz_label,
            tzOffset: member.tz_offset,
            profile: {
              title: member.profile?.title,
              phone: member.profile?.phone,
              skype: member.profile?.skype,
              realName: member.profile?.real_name,
              realNameNormalized: member.profile?.real_name_normalized,
              displayName: member.profile?.display_name,
              displayNameNormalized: member.profile?.display_name_normalized,
              statusText: member.profile?.status_text,
              statusEmoji: member.profile?.status_emoji,
              statusExpiration: member.profile?.status_expiration,
              avatarHash: member.profile?.avatar_hash,
              email: member.profile?.email,
              image24: member.profile?.image_24,
              image32: member.profile?.image_32,
              image48: member.profile?.image_48,
              image72: member.profile?.image_72,
              image192: member.profile?.image_192,
              image512: member.profile?.image_512,
              image1024: member.profile?.image_1024,
              imageOriginal: member.profile?.image_original,
              team: member.profile?.team,
            },
            isAdmin: Boolean(member.is_admin),
            isOwner: Boolean(member.is_owner),
            isPrimaryOwner: Boolean(member.is_primary_owner),
            isRestricted: Boolean(member.is_restricted),
            isUltraRestricted: Boolean(member.is_ultra_restricted),
            isBot: Boolean(member.is_bot),
            isAppUser: Boolean(member.is_app_user),
            updated: member.updated ?? 0,
          };
          const score = scoreSlackConnectorMatch(normalizedQuery, user.id, [
            user.name,
            user.realName,
            user.profile.displayName,
            user.profile.realName,
            user.profile.email,
          ]);
          if (score <= 0) {
            continue;
          }
          const target = this.buildConnectorUserTarget(user, score, accountId);
          if (target) {
            targets.push(target);
          }
        }
      } catch (error) {
        this.runtime.logger.debug(
          {
            src: "plugin:slack",
            agentId: this.runtime.agentId,
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Slack connector user query failed",
        );
      }

      if (context.target?.channelId) {
        const channel = await this.getChannel(
          context.target.channelId,
          accountId,
        );
        if (channel) {
          const target = this.buildConnectorChannelTarget(
            channel,
            0.6,
            accountId,
          );
          if (target) {
            targets.push(target);
          }
        }
      }
    }

    return this.dedupeConnectorTargets(targets).slice(0, 25);
  }

  async listConnectorRooms(
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const targets: MessageConnectorTarget[] = [];
    for (const accountId of this.getCandidateAccountIds(context)) {
      if (!this.getClientForAccount(accountId)) {
        continue;
      }
      const channels = await this.listChannels(
        {
          types: "public_channel,private_channel,mpim,im",
          limit: 1000,
        },
        accountId,
      );
      targets.push(
        ...channels
          .map((channel) =>
            this.buildConnectorChannelTarget(channel, 0.5, accountId),
          )
          .filter((target): target is MessageConnectorTarget =>
            Boolean(target),
          ),
      );
    }
    return this.dedupeConnectorTargets(targets).slice(0, 50);
  }

  async listRecentConnectorTargets(
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const targets: MessageConnectorTarget[] = [];
    const room =
      context.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(context.roomId)
        : null;
    const accountId = await this.resolveAccountIdForTarget(
      context.runtime,
      context.target,
      {
        accountId: (context as AccountScopedConnectorContext).accountId,
        roomId: context.roomId,
      },
    );
    const channelId =
      context.target?.channelId ??
      (room?.source === "slack" ? room.channelId : undefined);
    const roomMetadata = room?.metadata as Record<string, unknown> | undefined;
    const threadTs =
      context.target?.threadId ??
      (typeof roomMetadata?.threadTs === "string"
        ? roomMetadata.threadTs
        : undefined);

    if (channelId) {
      const channel = await this.getChannel(channelId, accountId);
      if (channel) {
        const target = this.buildConnectorChannelTarget(
          channel,
          0.95,
          accountId,
        );
        if (target) {
          if (threadTs) {
            target.kind = "thread";
            target.target.threadId = threadTs;
            target.label = `${target.label ?? channelId} thread`;
            target.metadata = {
              ...(target.metadata ?? {}),
              slackThreadTs: threadTs,
            };
          }
          targets.push(target);
        }
      }
    }

    targets.push(
      ...(await this.listConnectorRooms({
        ...context,
        accountId,
      } as MessageConnectorQueryContext)),
    );
    return this.dedupeConnectorTargets(targets).slice(0, 25);
  }

  async getConnectorChatContext(
    target: TargetInfo,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorChatContext | null> {
    const accountId = await this.resolveAccountIdForTarget(
      context.runtime,
      target,
      {
        accountId: (context as AccountScopedConnectorContext).accountId,
        roomId: context.roomId,
      },
    );
    const client = this.getClientForAccount(accountId);
    if (!client) {
      return null;
    }

    const room =
      target.roomId && typeof context.runtime.getRoom === "function"
        ? await context.runtime.getRoom(target.roomId)
        : null;
    const channelId = target.channelId ?? room?.channelId;
    if (!channelId) {
      return null;
    }

    const metadata = room?.metadata as Record<string, unknown> | undefined;
    const threadTs =
      target.threadId ??
      (typeof metadata?.threadTs === "string" ? metadata.threadTs : undefined);
    const channel = await this.getChannel(channelId, accountId);

    const messages = threadTs
      ? await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 10,
        })
      : {
          messages: await this.readHistory(channelId, { limit: 10 }, accountId),
        };
    const rawMessages = (messages.messages ?? []) as Array<
      SlackMessage | Record<string, unknown>
    >;
    const recentMessages: MessageConnectorChatContext["recentMessages"] = [];
    for (const rawMessage of rawMessages.slice().reverse()) {
      const text = String((rawMessage as SlackMessage).text ?? "");
      if (!text.trim()) {
        continue;
      }
      const userId =
        (rawMessage as SlackMessage).user ??
        (rawMessage as Record<string, string | undefined>).user;
      const user =
        typeof userId === "string"
          ? await this.getUser(userId, accountId)
          : null;
      recentMessages.push({
        entityId: userId ? (userId as UUID) : undefined,
        name: user ? getSlackUserDisplayName(user) : userId,
        text,
        timestamp: Number((rawMessage as SlackMessage).ts) * 1000 || undefined,
        metadata: {
          accountId,
          slackMessageTs: (rawMessage as SlackMessage).ts,
          slackUserId: userId,
        },
      });
    }

    return {
      target: {
        source: "slack",
        accountId,
        roomId: target.roomId ?? room?.id,
        channelId,
        serverId:
          target.serverId ?? this.getTeamIdForAccount(accountId) ?? undefined,
        threadId: threadTs,
      } as TargetInfo,
      label: channel?.name ? `#${channel.name}` : channelId,
      summary: channel?.purpose?.value || channel?.topic?.value,
      recentMessages,
      metadata: {
        accountId,
        slackChannelId: channelId,
        slackTeamId: this.getTeamIdForAccount(accountId),
        slackThreadTs: threadTs,
        channelName: channel?.name,
      },
    };
  }

  private async resolveConnectorMessageLocation(
    target?: TargetInfo | null,
    fallback?: ConnectorFetchMessagesParams,
  ): Promise<{ accountId: string; channelId: string; threadTs?: string }> {
    const accountId = await this.resolveAccountIdForTarget(
      this.runtime,
      target,
      fallback,
    );
    let channelId = target?.channelId ?? fallback?.channelId;
    let threadTs = target?.threadId ?? fallback?.threadId;
    const roomId = target?.roomId ?? fallback?.roomId;

    if (roomId && (!channelId || !threadTs)) {
      const room = await this.runtime.getRoom(roomId);
      channelId = channelId ?? room?.channelId;
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      const roomThreadTs =
        typeof metadata?.threadTs === "string" ? metadata.threadTs : undefined;
      threadTs = threadTs ?? roomThreadTs;
    }

    if (channelId && SLACK_USER_ID_PATTERN.test(channelId)) {
      channelId = await this.openDirectMessageChannel(channelId, accountId);
    }

    if (!channelId && target?.entityId) {
      const slackUserId = await this.resolveSlackTargetUserId(
        this.runtime,
        String(target.entityId),
        accountId,
      );
      if (slackUserId) {
        channelId = await this.openDirectMessageChannel(slackUserId, accountId);
      }
    }

    if (!channelId) {
      throw new Error(
        "Slack message operation requires channelId, roomId, or entityId.",
      );
    }

    return { accountId, channelId, threadTs };
  }

  private async slackMessageToMemory(
    message: SlackMessage,
    channelId: string,
    threadTs?: string,
    accountId = this.defaultAccountId,
  ): Promise<Memory> {
    const effectiveThreadTs = threadTs ?? message.threadTs;
    const roomId = await this.getRoomId(
      channelId,
      effectiveThreadTs,
      accountId,
    );
    const botUserId = this.getBotUserIdForAccount(accountId);
    const slackUserId = message.user ?? botUserId ?? "unknown";
    const entityId =
      slackUserId === botUserId
        ? this.runtime.agentId
        : this.getEntityId(slackUserId, accountId);
    const user = message.user
      ? await this.getUser(message.user, accountId)
      : null;
    const displayName = user ? getSlackUserDisplayName(user) : slackUserId;
    const channel = await this.getChannel(channelId, accountId).catch(
      () => null,
    );
    const channelType = effectiveThreadTs
      ? ChannelType.THREAD
      : channel?.isIm
        ? ChannelType.DM
        : ChannelType.GROUP;

    const attachments: Media[] = (message.files ?? []).map((file) => ({
      id: file.id,
      url: file.urlPrivate,
      title: file.title || file.name,
      source: "slack",
      description: file.name,
    }));

    return {
      id: createUniqueUuid(
        this.runtime,
        this.scopedSlackKey("slack", `${channelId}-${message.ts}`, accountId),
      ),
      agentId: this.runtime.agentId,
      roomId,
      entityId,
      content: {
        text: message.text || "",
        source: "slack",
        name: displayName,
        channelType,
        metadata: { accountId },
        ...(effectiveThreadTs && effectiveThreadTs !== message.ts
          ? {
              inReplyTo: createUniqueUuid(
                this.runtime,
                this.scopedSlackKey(
                  "slack",
                  `${channelId}-${effectiveThreadTs}`,
                  accountId,
                ),
              ),
            }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      metadata: {
        type: "message",
        source: "slack",
        provider: "slack",
        accountId,
        timestamp: this.parseSlackTimestamp(message.ts),
        entityName: displayName,
        entityUserName: user?.name ?? slackUserId,
        fromBot: slackUserId === botUserId,
        fromId: slackUserId,
        sourceId: entityId,
        chatType: channelType,
        messageIdFull: message.ts,
        sender: {
          id: slackUserId,
          name: displayName,
          username: user?.name ?? slackUserId,
        },
        slack: {
          accountId,
          teamId: this.getTeamIdForAccount(accountId) ?? undefined,
          channelId,
          userId: slackUserId,
          messageId: message.ts,
          threadTs: effectiveThreadTs,
        },
        slackChannelId: channelId,
        slackMessageTs: message.ts,
        slackThreadTs: effectiveThreadTs,
        reactions: message.reactions,
      } satisfies Memory["metadata"],
      createdAt: this.parseSlackTimestamp(message.ts),
    };
  }

  async listConnectorServers(
    context: MessageConnectorQueryContext,
  ): Promise<World[]> {
    const worlds: World[] = [];
    for (const accountId of this.getCandidateAccountIds(context)) {
      const teamId = this.getTeamIdForAccount(accountId);
      if (!teamId) {
        continue;
      }

      let name = `Slack Workspace ${teamId}`;
      try {
        const client = this.getClientForAccount(accountId);
        if (client) {
          const teamInfo = await client.team.info();
          const team = teamInfo.team as { name?: string } | undefined;
          name = team?.name || name;
        }
      } catch {
        // Best-effort metadata; the workspace id is still useful.
      }

      worlds.push({
        id: createUniqueUuid(
          this.runtime,
          this.scopedSlackKey("slack-workspace", teamId, accountId),
        ),
        agentId: this.runtime.agentId,
        name,
        metadata: {
          source: "slack",
          accountId,
          teamId,
        },
      });
    }

    return worlds;
  }

  async fetchConnectorMessages(
    _context: MessageConnectorQueryContext,
    params: ConnectorFetchMessagesParams,
  ): Promise<Memory[]> {
    const accountId = await this.resolveAccountIdForTarget(
      _context.runtime,
      params.target,
      { accountId: params.accountId, roomId: params.roomId },
    );
    const client = this.getClientForAccount(accountId);
    if (!client) {
      return [];
    }

    const { channelId, threadTs } = await this.resolveConnectorMessageLocation(
      params.target,
      { ...params, accountId },
    );
    const limit = normalizeConnectorLimit(params.limit, 25);

    const rawMessages = threadTs
      ? (((
          await client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit,
            latest: params.before,
            oldest: params.after,
            cursor: params.cursor,
          })
        ).messages as
          | Array<SlackMessage | Record<string, unknown>>
          | undefined) ?? [])
      : await this.readHistory(
          channelId,
          {
            limit,
            before: params.before,
            after: params.after,
          },
          accountId,
        );

    const memories: Memory[] = [];
    for (const rawMessage of rawMessages) {
      const message = rawMessage as SlackMessage;
      if (!message.ts) {
        continue;
      }
      memories.push(
        await this.slackMessageToMemory(
          message,
          channelId,
          threadTs,
          accountId,
        ),
      );
    }
    return memories.sort(
      (left, right) =>
        Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0),
    );
  }

  async searchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: ConnectorSearchMessagesParams,
  ): Promise<Memory[]> {
    const query = params.query?.trim().toLowerCase();
    if (!query) {
      return [];
    }

    const requestedLimit = normalizeConnectorLimit(params.limit, 25);
    const memories = await this.fetchConnectorMessages(context, {
      ...params,
      limit: Math.max(requestedLimit, 100),
    });
    return memories
      .filter((memory) => {
        const text = String(memory.content.text ?? "").toLowerCase();
        const name = String(memory.content.name ?? "").toLowerCase();
        return text.includes(query) || name.includes(query);
      })
      .slice(0, requestedLimit);
  }

  async reactConnectorMessage(
    _runtime: IAgentRuntime,
    params: ConnectorMessageMutationParams,
  ): Promise<void> {
    const { accountId, channelId } = await this.resolveConnectorMessageLocation(
      params.target,
      params,
    );
    const messageTs = params.messageTs ?? params.messageId;
    const emoji = params.emoji
      ? normalizeSlackEmojiName(params.emoji)
      : undefined;
    if (
      !messageTs ||
      !isValidMessageTs(messageTs) ||
      !emoji ||
      !isValidSlackEmojiName(emoji)
    ) {
      throw new Error("Slack reaction requires messageId/messageTs and emoji.");
    }
    if (params.remove) {
      await this.removeReaction(channelId, messageTs, emoji, accountId);
      return;
    }
    await this.sendReaction(channelId, messageTs, emoji, accountId);
  }

  async editConnectorMessage(
    _runtime: IAgentRuntime,
    params: ConnectorMessageMutationParams,
  ): Promise<Memory> {
    const { accountId, channelId, threadTs } =
      await this.resolveConnectorMessageLocation(params.target, params);
    const messageTs = params.messageTs ?? params.messageId;
    const text = params.content?.text ?? params.text;
    if (!messageTs || !isValidMessageTs(messageTs) || !text?.trim()) {
      throw new Error("Slack edit requires messageId/messageTs and text.");
    }

    await this.editMessage(channelId, messageTs, text, accountId);
    return this.slackMessageToMemory(
      {
        type: "message",
        ts: messageTs,
        user: this.getBotUserIdForAccount(accountId) ?? undefined,
        text,
        threadTs,
        subtype: undefined,
        replyCount: undefined,
        replyUsersCount: undefined,
        latestReply: undefined,
        reactions: undefined,
        files: undefined,
        attachments: undefined,
        blocks: undefined,
      },
      channelId,
      threadTs,
      accountId,
    );
  }

  async deleteConnectorMessage(
    _runtime: IAgentRuntime,
    params: ConnectorMessageMutationParams,
  ): Promise<void> {
    const { accountId, channelId } = await this.resolveConnectorMessageLocation(
      params.target,
      params,
    );
    const messageTs = params.messageTs ?? params.messageId;
    if (!messageTs || !isValidMessageTs(messageTs)) {
      throw new Error("Slack delete requires messageId/messageTs.");
    }
    await this.deleteMessage(channelId, messageTs, accountId);
  }

  async pinConnectorMessage(
    _runtime: IAgentRuntime,
    params: ConnectorMessageMutationParams,
  ): Promise<void> {
    const { accountId, channelId } = await this.resolveConnectorMessageLocation(
      params.target,
      params,
    );
    const messageTs = params.messageTs ?? params.messageId;
    if (!messageTs || !isValidMessageTs(messageTs)) {
      throw new Error("Slack pin requires messageId/messageTs.");
    }
    if (params.pin === false) {
      await this.unpinMessage(channelId, messageTs, accountId);
      return;
    }
    await this.pinMessage(channelId, messageTs, accountId);
  }

  async getConnectorUser(
    runtime: IAgentRuntime,
    params: ConnectorUserLookupParams,
  ): Promise<unknown> {
    const accountId = normalizeAccountId(
      (params.target as AccountScopedTargetInfo | undefined)?.accountId ??
        this.defaultAccountId ??
        DEFAULT_ACCOUNT_ID,
    );
    const lookup =
      params.userId ?? params.handle ?? params.username ?? params.query;
    if (!lookup) {
      return null;
    }

    let slackUserId = SLACK_USER_ID_PATTERN.test(lookup)
      ? lookup
      : await this.resolveSlackTargetUserId(runtime, lookup, accountId);

    const client = this.getClientForAccount(accountId);
    if (!slackUserId && client) {
      const usersResult = await client.users.list({ limit: 200 });
      const members = (usersResult.members ?? []) as SlackApiUserMember[];
      const normalized = normalizeSlackConnectorQuery(lookup);
      const match = members.find((member) =>
        [
          member.id,
          member.name,
          member.real_name,
          member.profile?.display_name,
          member.profile?.email,
        ]
          .filter((value): value is string => Boolean(value))
          .some((value) =>
            normalizeSlackConnectorQuery(value).includes(normalized),
          ),
      );
      slackUserId = match?.id ?? null;
    }

    if (!slackUserId) {
      return null;
    }

    const user = await this.getUser(slackUserId, accountId);
    if (!user) {
      return null;
    }

    return {
      id: this.getEntityId(user.id, accountId),
      agentId: this.runtime.agentId,
      names: [getSlackUserDisplayName(user), user.name, user.realName].filter(
        (value): value is string => Boolean(value),
      ),
      metadata: {
        source: "slack",
        accountId,
        slack: {
          accountId,
          id: user.id,
          teamId: user.teamId ?? this.getTeamIdForAccount(accountId),
          name: user.name,
          realName: user.realName,
          profile: { ...user.profile },
        },
      },
    };
  }

  async getConnectorUserContext(
    entityId: UUID | string,
    context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorUserContext | null> {
    const accountId = normalizeAccountId(
      (context.target as AccountScopedTargetInfo | undefined)?.accountId ??
        (context as AccountScopedConnectorContext).accountId ??
        (context as AccountScopedConnectorContext).account?.accountId ??
        this.defaultAccountId ??
        DEFAULT_ACCOUNT_ID,
    );
    const slackUserId = await this.resolveSlackTargetUserId(
      context.runtime,
      String(entityId),
      accountId,
    );
    if (!slackUserId) {
      return null;
    }
    const user = await this.getUser(slackUserId, accountId);
    if (!user) {
      return null;
    }

    return {
      entityId,
      label: getSlackUserDisplayName(user),
      aliases: [
        user.name,
        user.realName,
        user.profile.displayName,
        user.profile.realName,
        user.profile.email,
      ].filter((value): value is string => Boolean(value)),
      handles: {
        slack: user.id,
        ...(user.profile.email ? { email: user.profile.email } : {}),
      },
      metadata: {
        accountId,
        slackUserId: user.id,
        slackTeamId: user.teamId ?? this.getTeamIdForAccount(accountId),
        profile: { ...user.profile },
      },
    };
  }

  async getUser(
    userId: string,
    accountId?: string | null,
  ): Promise<SlackUser | null> {
    const userCache = this.getUserCacheForAccount(accountId);
    // Check cache first
    const cachedUser = userCache.get(userId);
    if (cachedUser) {
      return cachedUser;
    }

    const client = this.getClientForAccount(accountId);
    if (!client) return null;

    const result = await client.users.info({ user: userId });
    if (!result.user) return null;

    const user: SlackUser = {
      id: result.user.id ?? userId,
      teamId: result.user.team_id,
      name: result.user.name ?? "",
      deleted: result.user.deleted || false,
      realName: result.user.real_name,
      tz: result.user.tz,
      tzLabel: result.user.tz_label,
      tzOffset: result.user.tz_offset,
      profile: {
        title: result.user.profile?.title,
        phone: result.user.profile?.phone,
        skype: result.user.profile?.skype,
        realName: result.user.profile?.real_name,
        realNameNormalized: result.user.profile?.real_name_normalized,
        displayName: result.user.profile?.display_name,
        displayNameNormalized: result.user.profile?.display_name_normalized,
        statusText: result.user.profile?.status_text,
        statusEmoji: result.user.profile?.status_emoji,
        statusExpiration: result.user.profile?.status_expiration,
        avatarHash: result.user.profile?.avatar_hash,
        email: result.user.profile?.email,
        image24: result.user.profile?.image_24,
        image32: result.user.profile?.image_32,
        image48: result.user.profile?.image_48,
        image72: result.user.profile?.image_72,
        image192: result.user.profile?.image_192,
        image512: result.user.profile?.image_512,
        image1024: result.user.profile?.image_1024,
        imageOriginal: result.user.profile?.image_original,
        team: result.user.profile?.team,
      },
      isAdmin: result.user.is_admin || false,
      isOwner: result.user.is_owner || false,
      isPrimaryOwner: result.user.is_primary_owner || false,
      isRestricted: result.user.is_restricted || false,
      isUltraRestricted: result.user.is_ultra_restricted || false,
      isBot: result.user.is_bot || false,
      isAppUser: result.user.is_app_user || false,
      updated: result.user.updated || 0,
    };

    setBoundedCache(userCache, userId, user);
    return user;
  }

  async getChannel(
    channelId: string,
    accountId?: string | null,
  ): Promise<SlackChannel | null> {
    const channelCache = this.getChannelCacheForAccount(accountId);
    // Check cache first
    const cachedChannel = channelCache.get(channelId);
    if (cachedChannel) {
      return cachedChannel;
    }

    const client = this.getClientForAccount(accountId);
    if (!client) return null;

    const result = await client.conversations.info({ channel: channelId });
    if (!result.channel) return null;

    const channel: SlackChannel = {
      id: (result.channel as { id: string }).id,
      name: (result.channel as { name: string }).name || "",
      isChannel:
        (result.channel as { is_channel?: boolean }).is_channel || false,
      isGroup: (result.channel as { is_group?: boolean }).is_group || false,
      isIm: (result.channel as { is_im?: boolean }).is_im || false,
      isMpim: (result.channel as { is_mpim?: boolean }).is_mpim || false,
      isPrivate:
        (result.channel as { is_private?: boolean }).is_private || false,
      isArchived:
        (result.channel as { is_archived?: boolean }).is_archived || false,
      isGeneral:
        (result.channel as { is_general?: boolean }).is_general || false,
      isShared: (result.channel as { is_shared?: boolean }).is_shared || false,
      isOrgShared:
        (result.channel as { is_org_shared?: boolean }).is_org_shared || false,
      isMember: (result.channel as { is_member?: boolean }).is_member || false,
      topic: (
        result.channel as {
          topic?: { value: string; creator: string; last_set: number };
        }
      ).topic
        ? {
            value: (result.channel as { topic: { value: string } }).topic.value,
            creator: (result.channel as { topic: { creator: string } }).topic
              .creator,
            lastSet: (result.channel as { topic: { last_set: number } }).topic
              .last_set,
          }
        : undefined,
      purpose: (
        result.channel as {
          purpose?: { value: string; creator: string; last_set: number };
        }
      ).purpose
        ? {
            value: (result.channel as { purpose: { value: string } }).purpose
              .value,
            creator: (result.channel as { purpose: { creator: string } })
              .purpose.creator,
            lastSet: (result.channel as { purpose: { last_set: number } })
              .purpose.last_set,
          }
        : undefined,
      numMembers: (result.channel as { num_members?: number }).num_members,
      created: (result.channel as { created: number }).created,
      creator: (result.channel as { creator: string }).creator,
    };

    setBoundedCache(channelCache, channelId, channel);
    return channel;
  }

  async sendMessage(
    channelId: string,
    text: string,
    options?: SlackMessageSendOptions,
    accountId?: string | null,
  ): Promise<{
    ts: string;
    channelId: string;
    messages: Array<{ ts: string; text: string }>;
  }> {
    const client = this.getOutboundClient(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }

    // Split message if too long
    const convertedText = markdownToSlackMrkdwn(text);
    const messages = this.splitMessage(convertedText);
    let lastTs = "";
    const sentMessages: Array<{ ts: string; text: string }> = [];

    for (const [messageIndex, msg] of messages.entries()) {
      type SlackPostMessageArgs = Parameters<
        typeof client.chat.postMessage
      >[0] & {
        attachments?: SlackAttachment[];
        blocks?: SlackBlock[];
      };
      const messageArgs = {
        channel: channelId,
        text: msg,
        mrkdwn: options?.mrkdwn ?? true,
      } as SlackPostMessageArgs;
      if (options?.threadTs !== undefined) {
        messageArgs.thread_ts = options.threadTs;
      }
      if (options?.replyBroadcast !== undefined) {
        messageArgs.reply_broadcast = options.replyBroadcast;
      }
      if (options?.unfurlLinks !== undefined) {
        messageArgs.unfurl_links = options.unfurlLinks;
      }
      if (options?.unfurlMedia !== undefined) {
        messageArgs.unfurl_media = options.unfurlMedia;
      }
      if (options?.attachments) {
        messageArgs.attachments = options.attachments;
      }
      if (options?.blocks && messageIndex === messages.length - 1) {
        messageArgs.blocks = options.blocks;
      }

      const result = await client.chat.postMessage(messageArgs);

      if (typeof result.ts !== "string" || !isValidMessageTs(result.ts)) {
        throw new ElizaError(
          "Slack chat.postMessage returned no message timestamp",
          {
            code: "SLACK_POST_MESSAGE_IDENTITY_MISSING",
            context: { accountId: normalizeAccountId(accountId), channelId },
          },
        );
      }
      lastTs = result.ts;
      sentMessages.push({ ts: result.ts, text: msg });
    }

    return { ts: lastTs, channelId, messages: sentMessages };
  }

  async sendReaction(
    channelId: string,
    messageTs: string,
    emoji: string,
    accountId?: string | null,
  ): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }

    // Remove colons if present
    const cleanEmoji = normalizeSlackEmojiName(emoji);
    if (
      !isValidChannelId(channelId) ||
      !isValidMessageTs(messageTs) ||
      !cleanEmoji ||
      !isValidSlackEmojiName(cleanEmoji)
    ) {
      throw new Error(
        "Slack reaction requires valid channelId, messageTs, and emoji.",
      );
    }

    await client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: cleanEmoji,
    });
  }

  async removeReaction(
    channelId: string,
    messageTs: string,
    emoji: string,
    accountId?: string | null,
  ): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }

    const cleanEmoji = normalizeSlackEmojiName(emoji);
    if (
      !isValidChannelId(channelId) ||
      !isValidMessageTs(messageTs) ||
      !cleanEmoji ||
      !isValidSlackEmojiName(cleanEmoji)
    ) {
      throw new Error(
        "Slack reaction requires valid channelId, messageTs, and emoji.",
      );
    }

    await client.reactions.remove({
      channel: channelId,
      timestamp: messageTs,
      name: cleanEmoji,
    });
  }

  async editMessage(
    channelId: string,
    messageTs: string,
    text: string,
    accountId?: string | null,
  ): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }
    if (!isValidChannelId(channelId) || !isValidMessageTs(messageTs)) {
      throw new Error("Slack edit requires valid channelId and messageTs.");
    }

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
    });
  }

  async deleteMessage(
    channelId: string,
    messageTs: string,
    accountId?: string | null,
  ): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }
    if (!isValidChannelId(channelId) || !isValidMessageTs(messageTs)) {
      throw new Error("Slack delete requires valid channelId and messageTs.");
    }

    await client.chat.delete({
      channel: channelId,
      ts: messageTs,
    });
  }

  async pinMessage(
    channelId: string,
    messageTs: string,
    accountId?: string | null,
  ): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }
    if (!isValidChannelId(channelId) || !isValidMessageTs(messageTs)) {
      throw new Error("Slack pin requires valid channelId and messageTs.");
    }

    await client.pins.add({
      channel: channelId,
      timestamp: messageTs,
    });
  }

  async unpinMessage(
    channelId: string,
    messageTs: string,
    accountId?: string | null,
  ): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }
    if (!isValidChannelId(channelId) || !isValidMessageTs(messageTs)) {
      throw new Error("Slack pin requires valid channelId and messageTs.");
    }

    await client.pins.remove({
      channel: channelId,
      timestamp: messageTs,
    });
  }

  async listPins(
    channelId: string,
    accountId?: string | null,
  ): Promise<SlackMessage[]> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }

    const result = await client.pins.list({ channel: channelId });

    return (result.items || [])
      .filter(
        (item): item is { type: "message"; message: Record<string, unknown> } =>
          item.type === "message" && "message" in item && !!item.message,
      )
      .map((item) => ({
        type: item.message.type as string,
        subtype: item.message.subtype as string | undefined,
        ts: item.message.ts as string,
        user: item.message.user as string | undefined,
        text: item.message.text as string,
        threadTs: item.message.thread_ts as string | undefined,
        replyCount: item.message.reply_count as number | undefined,
        replyUsersCount: item.message.reply_users_count as number | undefined,
        latestReply: item.message.latest_reply as string | undefined,
        reactions: item.message.reactions as
          | { name: string; count: number; users: string[] }[]
          | undefined,
        files: item.message.files as SlackFile[] | undefined,
        attachments: item.message.attachments as SlackAttachment[] | undefined,
        blocks: item.message.blocks as SlackBlock[] | undefined,
      }));
  }

  async readHistory(
    channelId: string,
    options?: { limit?: number; before?: string; after?: string },
    accountId?: string | null,
  ): Promise<SlackMessage[]> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }

    const result = await client.conversations.history({
      channel: channelId,
      limit: options?.limit || 100,
      latest: options?.before,
      oldest: options?.after,
    });

    return (result.messages || []).map((msg) => ({
      type: msg.type as string,
      subtype: msg.subtype as string | undefined,
      ts: msg.ts as string,
      user: msg.user as string | undefined,
      text: msg.text as string,
      threadTs: msg.thread_ts as string | undefined,
      replyCount: msg.reply_count as number | undefined,
      replyUsersCount: msg.reply_users_count as number | undefined,
      latestReply: msg.latest_reply as string | undefined,
      reactions: msg.reactions as
        | { name: string; count: number; users: string[] }[]
        | undefined,
      files: msg.files as SlackFile[] | undefined,
      attachments: msg.attachments as SlackAttachment[] | undefined,
      blocks: msg.blocks as SlackBlock[] | undefined,
    }));
  }

  async listChannels(
    options?: {
      types?: string;
      limit?: number;
    },
    accountId?: string | null,
  ): Promise<SlackChannel[]> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }

    const result = await client.conversations.list({
      types: options?.types || "public_channel,private_channel",
      limit: options?.limit || 1000,
    });

    return (result.channels || []).map((ch) => ({
      id: ch.id ?? "",
      name: ch.name || "",
      isChannel: ch.is_channel || false,
      isGroup: ch.is_group || false,
      isIm: ch.is_im || false,
      isMpim: ch.is_mpim || false,
      isPrivate: ch.is_private || false,
      isArchived: ch.is_archived || false,
      isGeneral: ch.is_general || false,
      isShared: ch.is_shared || false,
      isOrgShared: ch.is_org_shared || false,
      isMember: ch.is_member || false,
      topic: ch.topic
        ? {
            value: ch.topic.value ?? "",
            creator: ch.topic.creator ?? "",
            lastSet: ch.topic.last_set ?? 0,
          }
        : undefined,
      purpose: ch.purpose
        ? {
            value: ch.purpose.value ?? "",
            creator: ch.purpose.creator ?? "",
            lastSet: ch.purpose.last_set ?? 0,
          }
        : undefined,
      numMembers: ch.num_members,
      created: ch.created || 0,
      creator: ch.creator || "",
    }));
  }

  async getEmojiList(
    accountId?: string | null,
  ): Promise<Record<string, string>> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }

    const result = await client.emoji.list();
    return (result.emoji || {}) as Record<string, string>;
  }

  async uploadFile(
    channelId: string,
    content: Buffer | string,
    filename: string,
    options?: { title?: string; initialComment?: string; threadTs?: string },
    accountId?: string | null,
  ): Promise<{ fileId: string; permalink: string }> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Slack client not initialized");
    }

    const uploadArgs = {
      channel_id: channelId,
      filename,
      ...(typeof content === "string" ? { content } : { file: content }),
    } as Parameters<typeof client.files.uploadV2>[0];
    if (options?.title !== undefined) {
      uploadArgs.title = options.title;
    }
    if (options?.initialComment !== undefined) {
      uploadArgs.initial_comment = options.initialComment;
    }
    if (options?.threadTs !== undefined) {
      uploadArgs.thread_ts = options.threadTs;
    }

    const result = await client.files.uploadV2(uploadArgs);

    const resultWithFile = result as WebAPICallResult & {
      file?: { id: string; permalink: string };
    };
    const file = resultWithFile.file;
    return {
      fileId: file?.id || "",
      permalink: file?.permalink || "",
    };
  }

  private splitMessage(text: string): string[] {
    return splitSlackText(text, MAX_SLACK_MESSAGE_LENGTH);
  }

  async addAllowedChannel(
    channelId: string,
    accountId?: string | null,
  ): Promise<boolean> {
    if (!isValidChannelId(channelId)) return false;
    return (
      (await this.getPolicyForAccount(accountId)?.registerBotJoin(channelId)) ??
      false
    );
  }

  /**
   * Remove a channel from the dynamic allowed list
   */
  removeAllowedChannel(channelId: string, accountId?: string | null): void {
    this.getPolicyForAccount(accountId)?.registerBotLeave(channelId);
  }

  /**
   * Get all currently allowed channel IDs
   */
  getAllowedChannelIds(accountId?: string | null): string[] {
    return this.getPolicyForAccount(accountId)?.listAllowedChannelIds() ?? [];
  }

  /**
   * Check if the service is connected
   */
  isServiceConnected(): boolean {
    return this.isConnected && this.app !== null;
  }

  /**
   * Get the bot's user ID
   */
  getBotUserId(): string | null {
    return this.botUserId;
  }

  /**
   * Get the team/workspace ID
   */
  getTeamId(): string | null {
    return this.teamId;
  }

  /**
   * Clear the user cache
   */
  clearUserCache(): void {
    this.userCache.clear();
  }

  /**
   * Clear the channel cache
   */
  clearChannelCache(): void {
    this.channelCache.clear();
  }
}
