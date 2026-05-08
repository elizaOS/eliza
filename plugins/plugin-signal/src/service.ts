import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChannelType,
  type Character,
  type Content,
  type ContentType,
  createMessageMemory,
  createUniqueUuid,
  type EventPayload,
  type HandlerCallback,
  type IAgentRuntime,
  type IMessageService,
  lifeOpsPassiveConnectorsEnabled,
  type Media,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  type Room,
  Service,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import {
  createSignalEventStream,
  parseSignalEventData,
  signalCheck,
  signalListContacts,
  signalListGroups,
  signalRpcRequest,
  signalSend,
  signalSendReaction,
  signalSendTyping,
} from "./rpc";
import {
  DEFAULT_ACCOUNT_ID,
  listEnabledSignalAccounts,
  normalizeAccountId as normalizeSignalAccountId,
  resolveDefaultSignalAccountId,
} from "./accounts";

type MessageService = Pick<IMessageService, "handleMessage">;
type MessageConnectorRegistration = Parameters<IAgentRuntime["registerMessageConnector"]>[0];

type ConnectorFetchMessagesParams = {
  target?: TargetInfo;
  limit?: number;
  before?: string;
  after?: string;
  channelId?: string;
  roomId?: UUID;
};

type ConnectorSearchMessagesParams = ConnectorFetchMessagesParams & {
  query?: string;
};

type ConnectorReactionParams = {
  target?: TargetInfo;
  channelId?: string;
  roomId?: UUID;
  messageId?: string;
  targetTimestamp?: number;
  targetAuthor?: string;
  emoji?: string;
  remove?: boolean;
};

type ConnectorUserLookupParams = {
  userId?: string;
  username?: string;
  handle?: string;
  query?: string;
};

type ExtendedMessageConnectorRegistration = MessageConnectorRegistration & {
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params: ConnectorFetchMessagesParams
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: MessageConnectorQueryContext,
    params: ConnectorSearchMessagesParams
  ) => Promise<Memory[]>;
  reactHandler?: (runtime: IAgentRuntime, params: ConnectorReactionParams) => Promise<void>;
  getUser?: (runtime: IAgentRuntime, params: ConnectorUserLookupParams) => Promise<unknown>;
};

const getMessageService = (runtime: IAgentRuntime): MessageService | null => {
  if ("messageService" in runtime) {
    const withMessageService = runtime as IAgentRuntime & {
      messageService?: MessageService | null;
    };
    return withMessageService.messageService ?? null;
  }
  return null;
};

function normalizeSignalQuery(query: string): string {
  return query.trim().toLowerCase();
}

function scoreSignalCandidate(values: Array<string | undefined>, query: string): number {
  const normalized = normalizeSignalQuery(query);
  if (!normalized) {
    return 0.4;
  }

  const candidates = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());

  if (candidates.some((candidate) => candidate === normalized)) {
    return 1;
  }
  if (candidates.some((candidate) => candidate.includes(normalized))) {
    return 0.85;
  }

  const digits = normalized.replace(/\D/g, "");
  if (digits && candidates.some((candidate) => candidate.replace(/\D/g, "").includes(digits))) {
    return 0.8;
  }

  return 0;
}

function signalContactToConnectorTarget(
  contact: SignalContact,
  accountId: string,
  score = 0.5
): MessageConnectorTarget {
  const label = getSignalContactDisplayName(contact);
  return {
    target: {
      source: SIGNAL_SERVICE_NAME,
      accountId,
      channelId: contact.number,
      entityId: stringToUuid(`signal-user-${contact.number}`),
    },
    label,
    kind: "contact",
    description: contact.blocked ? "Blocked Signal contact" : "Signal contact",
    score,
    contexts: ["social", "connectors"],
    metadata: {
      accountId,
      number: contact.number,
      uuid: contact.uuid,
      blocked: contact.blocked,
    },
  };
}

function signalGroupToConnectorTarget(
  group: SignalGroup,
  accountId: string,
  score = 0.5
): MessageConnectorTarget {
  return {
    target: {
      source: SIGNAL_SERVICE_NAME,
      accountId,
      channelId: group.id,
    },
    label: group.name || `Signal Group ${group.id}`,
    kind: "group",
    description:
      group.description ||
      `${group.members.length} Signal member${group.members.length === 1 ? "" : "s"}`,
    score,
    contexts: ["social", "connectors"],
    metadata: {
      accountId,
      groupId: group.id,
      isMember: group.isMember,
      isBlocked: group.isBlocked,
      memberCount: group.members.length,
    },
  };
}

function signalRecentToConnectorTarget(
  recent: SignalRecentMessage,
  accountId: string,
  score = 0.55
): MessageConnectorTarget {
  return {
    target: {
      source: SIGNAL_SERVICE_NAME,
      accountId,
      roomId: recent.roomId as UUID,
      channelId: recent.channelId,
    },
    label: recent.roomName,
    kind: recent.isGroup ? "group" : "contact",
    description: `${recent.speakerName}: ${recent.text.slice(0, 120)}`,
    score,
    contexts: ["social", "connectors"],
    metadata: {
      accountId,
      recentMessageId: recent.id,
      isGroup: recent.isGroup,
      createdAt: recent.createdAt,
    },
  };
}

import { missingSignalCliMessage, resolveSignalCliExecutable } from "./pairing-service";
import {
  getSignalContactDisplayName,
  type ISignalService,
  isValidGroupId,
  isValidUuid,
  MAX_SIGNAL_MESSAGE_LENGTH,
  normalizeE164,
  SIGNAL_SERVICE_NAME,
  type SignalAttachment,
  type SignalContact,
  SignalEventTypes,
  type SignalGroup,
  type SignalMessage,
  type SignalMessageSendOptions,
  type SignalQuote,
  type SignalReactionInfo,
  type SignalRecentMessage,
  type SignalSettings,
} from "./types";

export const DEFAULT_SIGNAL_HTTP_HOST = "127.0.0.1";
export const DEFAULT_SIGNAL_HTTP_PORT = 8080;
const DEFAULT_SIGNAL_DAEMON_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_SIGNAL_CLI_PATH = "signal-cli";
const BREW_OPENJDK_HOME = "/opt/homebrew/opt/openjdk";

/**
 * signal-cli uses `$HOME/.local/share/signal-cli` as its default data
 * directory on every platform (the XDG path is hardcoded in signal-cli —
 * it does not honour `Library/Application Support` on macOS). Matching
 * that default here means a locally-installed signal-cli + a user who
 * ran `signal-cli -a +1555… link` once will "just work" — no config
 * needed beyond `SIGNAL_ACCOUNT_NUMBER`.
 *
 * Override with `SIGNAL_AUTH_DIR` to point at a custom install.
 */
export function defaultSignalAuthDir(): string {
  const home = os.homedir();
  return path.join(home, ".local", "share", "signal-cli");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function buildSignalCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const javaHome =
    (fs.existsSync(BREW_OPENJDK_HOME) ? BREW_OPENJDK_HOME : null) ||
    (typeof env.JAVA_HOME === "string" && env.JAVA_HOME.trim().length > 0
      ? env.JAVA_HOME.trim()
      : null);

  if (javaHome) {
    env.JAVA_HOME = javaHome;
    const javaBin = path.join(javaHome, "bin");
    env.PATH = env.PATH ? `${javaBin}:${env.PATH}` : javaBin;
  }

  return env;
}

/**
 * Signal API client for HTTP API mode
 */
class SignalApiClient {
  constructor(
    public readonly baseUrl: string,
    public readonly accountNumber: string
  ) {}

  private rpcOptions(timeoutMs?: number): {
    baseUrl: string;
    timeoutMs?: number;
  } {
    return timeoutMs ? { baseUrl: this.baseUrl, timeoutMs } : { baseUrl: this.baseUrl };
  }

  async sendMessage(
    recipient: string,
    message: string,
    options?: SignalMessageSendOptions
  ): Promise<{ timestamp: number }> {
    return signalSend(
      {
        account: this.accountNumber,
        recipients: [recipient],
        message,
        ...(options?.attachments ? { attachments: options.attachments } : {}),
        ...(options?.quote ? { quote: options.quote } : {}),
      },
      this.rpcOptions()
    );
  }

  async sendGroupMessage(
    groupId: string,
    message: string,
    options?: SignalMessageSendOptions
  ): Promise<{ timestamp: number }> {
    return signalSend(
      {
        account: this.accountNumber,
        groupId,
        message,
        ...(options?.attachments ? { attachments: options.attachments } : {}),
      },
      this.rpcOptions()
    );
  }

  async sendReaction(
    recipient: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string,
    remove = false
  ): Promise<void> {
    await signalSendReaction(
      {
        account: this.accountNumber,
        recipient,
        emoji,
        targetAuthor,
        targetTimestamp,
        remove,
      },
      this.rpcOptions()
    );
  }

  async getContacts(): Promise<SignalContact[]> {
    return signalListContacts(this.accountNumber, this.rpcOptions()) as Promise<SignalContact[]>;
  }

  async getGroups(): Promise<SignalGroup[]> {
    return signalListGroups(this.accountNumber, this.rpcOptions()) as Promise<SignalGroup[]>;
  }

  async getGroup(groupId: string): Promise<SignalGroup | null> {
    const groups = await this.getGroups();
    return groups.find((g) => g.id === groupId) || null;
  }

  async receive(): Promise<SignalMessage[]> {
    return signalRpcRequest<SignalMessage[]>(
      "receive",
      { account: this.accountNumber },
      this.rpcOptions(1_500)
    ).catch((error) => {
      if (error instanceof Error && error.name === "AbortError") {
        return [];
      }
      throw error;
    });
  }

  async sendTyping(recipient: string, stop = false): Promise<void> {
    await signalSendTyping(
      {
        account: this.accountNumber,
        recipient,
        stop,
      },
      this.rpcOptions()
    );
  }

  async setProfile(name: string, about?: string): Promise<void> {
    await signalRpcRequest(
      "setProfile",
      {
        account: this.accountNumber,
        name,
        about: about || "",
      },
      this.rpcOptions()
    );
  }

  async getIdentities(): Promise<
    Array<{ number: string; safety_number: string; trust_level: string }>
  > {
    return signalRpcRequest("listIdentities", { account: this.accountNumber }, this.rpcOptions());
  }

  async trustIdentity(
    number: string,
    trustLevel: "TRUSTED_VERIFIED" | "TRUSTED_UNVERIFIED" | "UNTRUSTED"
  ): Promise<void> {
    await signalRpcRequest(
      "trustIdentity",
      {
        account: this.accountNumber,
        number,
        trustLevel,
      },
      this.rpcOptions()
    );
  }
}

/**
 * SignalService class for interacting with Signal via HTTP API or CLI
 */
export class SignalService extends Service implements ISignalService {
  static serviceType: string = SIGNAL_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages on Signal";

  async stop(): Promise<void> {
    await this.shutdown();
  }

  character: Character;
  accountNumber: string | null = null;
  isConnected = false;

  private defaultAccountId = DEFAULT_ACCOUNT_ID;
  private accountNumbers: Map<string, string> = new Map();
  private clients: Map<string, SignalApiClient> = new Map();
  private client: SignalApiClient | null = null;
  private settings: SignalSettings;
  private contactCache: Map<string, SignalContact> = new Map();
  private contactCaches: Map<string, Map<string, SignalContact>> = new Map();
  private groupCache: Map<string, SignalGroup> = new Map();
  private groupCaches: Map<string, Map<string, SignalGroup>> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private eventStream: ReturnType<typeof createSignalEventStream> | null = null;
  private eventStreams: Map<string, ReturnType<typeof createSignalEventStream>> = new Map();
  private isPolling = false;
  private daemonProcess: ChildProcess | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.character = runtime.character;
      this.settings = this.loadSettings();
    } else {
      this.character = {} as Character;
      this.settings = {
        shouldIgnoreGroupMessages: false,
        allowedGroups: undefined,
        blockedNumbers: undefined,
        autoReply: false,
        receiveMode: "manual",
      };
    }
  }

  private loadSettings(): SignalSettings {
    const ignoreGroups = this.runtime.getSetting("SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES");
    const autoReply = this.runtime.getSetting("SIGNAL_AUTO_REPLY");
    const receiveMode = this.runtime.getSetting("SIGNAL_RECEIVE_MODE");

    return {
      shouldIgnoreGroupMessages: ignoreGroups === "true" || ignoreGroups === true,
      allowedGroups: undefined,
      blockedNumbers: undefined,
      autoReply:
        !lifeOpsPassiveConnectorsEnabled(this.runtime) &&
        (autoReply === "true" || autoReply === true),
      receiveMode: receiveMode === "on-start" ? "on-start" : "manual",
    };
  }

  private normalizeAccountId(accountId?: string | null): string {
    return normalizeSignalAccountId(accountId ?? this.defaultAccountId);
  }

  private getConnectorAccountIds(): string[] {
    const ids = this.clients instanceof Map ? Array.from(this.clients.keys()) : [];
    if (ids.length > 0) {
      return ids;
    }
    return [this.defaultAccountId];
  }

  private getClientForAccount(accountId?: string | null): SignalApiClient | null {
    const normalized = this.normalizeAccountId(accountId);
    return (
      (this.clients instanceof Map ? this.clients.get(normalized) : null) ??
      (normalized === this.defaultAccountId ? this.client : null)
    );
  }

  private getAccountNumberForAccount(accountId?: string | null): string | null {
    const normalized = this.normalizeAccountId(accountId);
    return (
      (this.accountNumbers instanceof Map ? this.accountNumbers.get(normalized) : null) ??
      (normalized === this.defaultAccountId ? this.accountNumber : null)
    );
  }

  private cacheContacts(accountId: string, contacts: SignalContact[]): void {
    const accountCache = this.contactCaches.get(accountId) ?? new Map<string, SignalContact>();
    for (const contact of contacts) {
      accountCache.set(contact.number, contact);
      if (accountId === this.defaultAccountId) {
        this.contactCache.set(contact.number, contact);
      }
    }
    this.contactCaches.set(accountId, accountCache);
  }

  private cacheGroups(accountId: string, groups: SignalGroup[]): void {
    const accountCache = this.groupCaches.get(accountId) ?? new Map<string, SignalGroup>();
    for (const group of groups) {
      accountCache.set(group.id, group);
      if (accountId === this.defaultAccountId) {
        this.groupCache.set(group.id, group);
      }
    }
    this.groupCaches.set(accountId, accountCache);
  }

  private getCachedContact(number: string, accountId?: string | null): SignalContact | undefined {
    const normalized = this.normalizeAccountId(accountId);
    return this.contactCaches.get(normalized)?.get(number) ?? this.contactCache.get(number);
  }

  private getCachedGroupForAccount(
    groupId: string,
    accountId?: string | null
  ): SignalGroup | undefined {
    const normalized = this.normalizeAccountId(accountId);
    return this.groupCaches.get(normalized)?.get(groupId) ?? this.groupCache.get(groupId);
  }

  private accountScopedKey(accountId: string, kind: string, value: string): string {
    return accountId === DEFAULT_ACCOUNT_ID
      ? `signal-${kind}-${value}`
      : `signal-${kind}-${accountId}-${value}`;
  }

  static async start(runtime: IAgentRuntime): Promise<SignalService> {
    const service = new SignalService(runtime);
    const accounts = listEnabledSignalAccounts(runtime);
    const rawAuthDir = runtime.getSetting("SIGNAL_AUTH_DIR") as string | undefined;
    const defaultAuthDir =
      typeof rawAuthDir === "string" && rawAuthDir.trim().length > 0
        ? rawAuthDir.trim()
        : defaultSignalAuthDir();
    const configuredCliPath =
      (runtime.getSetting("SIGNAL_CLI_PATH") as string | undefined) || DEFAULT_SIGNAL_CLI_PATH;
    const parsedStartupTimeout = Number.parseInt(
      String(runtime.getSetting("SIGNAL_STARTUP_TIMEOUT_MS") ?? ""),
      10
    );
    const startupTimeoutMs =
      Number.isFinite(parsedStartupTimeout) && parsedStartupTimeout > 0
        ? Math.min(parsedStartupTimeout, 120_000)
        : DEFAULT_SIGNAL_DAEMON_STARTUP_TIMEOUT_MS;

    if (accounts.length === 0) {
      runtime.logger.warn(
        { src: "plugin:signal", agentId: runtime.agentId },
        "SIGNAL_ACCOUNT_NUMBER not provided, Signal service will not start"
      );
      return service;
    }

    service.defaultAccountId = resolveDefaultSignalAccountId(runtime);

    for (const account of accounts) {
      const accountNumber = account.account;
      if (!accountNumber) {
        runtime.logger.warn(
          { src: "plugin:signal", agentId: runtime.agentId, accountId: account.accountId },
          "Signal account is missing account number, skipping"
        );
        continue;
      }

      const normalizedNumber = normalizeE164(accountNumber);
      if (!normalizedNumber) {
        runtime.logger.error(
          {
            src: "plugin:signal",
            agentId: runtime.agentId,
            accountId: account.accountId,
            accountNumber,
          },
          "Invalid Signal account number format"
        );
        continue;
      }

      const baseUrl = normalizeBaseUrl(account.baseUrl);
      const explicitHttpUrl = Boolean(account.config.httpUrl?.trim());
      const authDir = account.config.authDir?.trim() || defaultAuthDir;
      const accountCliPath =
        (account.config.cliPath && account.config.cliPath.trim()) || configuredCliPath;

      if (!explicitHttpUrl) {
        // authDir is now guaranteed non-empty (falls back to defaultSignalAuthDir()).
        // If the directory does not exist, signal-cli would fail on startup with
        // a confusing "No linked devices" error — pre-empt that with a clearer
        // warning that points at the user's next action.
        if (!fs.existsSync(authDir)) {
          runtime.logger.warn(
            {
              src: "plugin:signal",
              agentId: runtime.agentId,
              accountId: account.accountId,
              authDir,
            },
            "Signal auth directory does not exist yet — run `signal-cli -a <number> link` (or set SIGNAL_AUTH_DIR to a pre-existing install) before starting the plugin"
          );
          continue;
        }

        try {
          await service.ensureDaemonRunning(accountCliPath, authDir, baseUrl, startupTimeoutMs);
        } catch (error) {
          runtime.logger.error(
            {
              src: "plugin:signal",
              agentId: runtime.agentId,
              accountId: account.accountId,
              error: String(error),
              authDir,
              cliPath: accountCliPath,
            },
            "Failed to start signal-cli daemon"
          );
          continue;
        }
      }

      const client = new SignalApiClient(baseUrl, normalizedNumber);
      service.clients.set(account.accountId, client);
      service.accountNumbers.set(account.accountId, normalizedNumber);
      if (account.accountId === service.defaultAccountId || !service.client) {
        service.client = client;
        service.accountNumber = normalizedNumber;
      }
    }

    if (service.clients.size === 0) {
      runtime.logger.warn(
        { src: "plugin:signal", agentId: runtime.agentId },
        "No configured Signal accounts could be initialized"
      );
      return service;
    }

    try {
      await service.initialize();
    } catch (error) {
      runtime.logger.warn(
        {
          src: "plugin:signal",
          agentId: runtime.agentId,
          error: String(error),
        },
        "Signal service failed to initialize"
      );
    }

    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: SignalService): void {
    const sendHandler = async (_runtime: IAgentRuntime, target: TargetInfo, content: Content) => {
      const accountId = service.normalizeAccountId(target.accountId);
      const text = typeof content.text === "string" ? content.text.trim() : "";
      if (!text) {
        return;
      }

      const room = target.roomId ? await runtime.getRoom(target.roomId) : null;
      const channelId = String(target.channelId ?? room?.channelId ?? "").trim();
      if (!channelId) {
        throw new Error("Signal target is missing a channel identifier");
      }

      const isGroup = room?.type === ChannelType.GROUP;
      const result = isGroup
        ? await service.sendGroupMessage(channelId, text, { record: false, accountId })
        : await service.sendMessage(channelId, text, { record: false, accountId });

      if (!target.roomId) {
        return;
      }

      const memory = createMessageMemory({
        id: createUniqueUuid(runtime, `signal:${result.timestamp}`),
        entityId: runtime.agentId,
        roomId: target.roomId,
        content: {
          ...content,
          text,
          source: "signal",
        },
      }) as Memory;
      memory.metadata = {
        ...(memory.metadata ?? {}),
        accountId,
        messageIdFull: String(result.timestamp),
        signalTimestamp: result.timestamp,
        signal: {
          accountId,
          timestamp: result.timestamp,
        },
      };
      return memory;
    };

    if (typeof runtime.registerMessageConnector === "function") {
      const accountIds = service.getConnectorAccountIds();
      const registrationAccountIds =
        accountIds.length > 1 ? accountIds : [undefined as string | undefined];

      for (const registrationAccountId of registrationAccountIds) {
        const connectorAccountId = service.normalizeAccountId(registrationAccountId);
        const registration: ExtendedMessageConnectorRegistration = {
          source: SIGNAL_SERVICE_NAME,
          ...(registrationAccountId ? { accountId: connectorAccountId } : {}),
          label:
            registrationAccountId && connectorAccountId !== DEFAULT_ACCOUNT_ID
              ? `Signal (${connectorAccountId})`
              : "Signal",
          capabilities: [
            "send_message",
            "send_direct_message",
            "send_group_message",
            "send_reaction",
            "read_messages",
            "search_messages",
            "list_contacts",
            "list_groups",
            "read_recent_messages",
            "get_user",
          ],
          supportedTargetKinds: ["contact", "phone", "group", "room"],
          contexts: ["social", "connectors"],
          description:
            "Send, read, search, and react in Signal direct and group conversations with known contacts, phone numbers, groups, and recent Signal rooms.",
          metadata: {
            accountId: connectorAccountId,
          },
          sendHandler: (handlerRuntime, target, content) =>
            sendHandler(
              handlerRuntime,
              target.accountId
                ? target
                : ({ ...target, accountId: connectorAccountId } as TargetInfo),
              content
            ),
          resolveTargets: async (query) => {
            const contacts = await service.listConnectorContacts(connectorAccountId);
            const groups = await service.listConnectorGroups(connectorAccountId);
            const recentMessages = await service
              .getRecentMessages(30, connectorAccountId)
              .catch(() => []);
            const recentTargets = recentMessages
              .map((recent) => ({
                recent,
                score: scoreSignalCandidate(
                  [recent.roomName, recent.channelId, recent.speakerName, recent.text],
                  query
                ),
              }))
              .filter(({ score }) => score > 0)
              .map(({ recent, score }) =>
                signalRecentToConnectorTarget(recent, connectorAccountId, score)
              );

            const contactTargets = contacts
              .map((contact) => ({
                contact,
                score: scoreSignalCandidate(
                  [contact.number, contact.name, contact.profileName, contact.uuid],
                  query
                ),
              }))
              .filter(({ score }) => score > 0)
              .map(({ contact, score }) =>
                signalContactToConnectorTarget(contact, connectorAccountId, score)
              );

            const groupTargets = groups
              .map((group) => ({
                group,
                score: scoreSignalCandidate([group.id, group.name, group.description], query),
              }))
              .filter(({ score }) => score > 0)
              .map(({ group, score }) =>
                signalGroupToConnectorTarget(group, connectorAccountId, score)
              );

            return [...contactTargets, ...groupTargets, ...recentTargets]
              .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
              .slice(0, 12);
          },
          listRecentTargets: async () => {
            const recent = await service.getRecentMessages(12, connectorAccountId).catch(() => []);
            return recent.map((message) =>
              signalRecentToConnectorTarget(message, connectorAccountId)
            );
          },
          listRooms: async () => {
            const groups = await service.listConnectorGroups(connectorAccountId);
            return groups.map((group) => signalGroupToConnectorTarget(group, connectorAccountId));
          },
          fetchMessages: (context, params) =>
            service.fetchConnectorMessages(
              {
                ...context,
                accountId: context.accountId ?? connectorAccountId,
                target:
                  context.target && !context.target.accountId
                    ? ({ ...context.target, accountId: connectorAccountId } as TargetInfo)
                    : context.target,
              },
              {
                ...params,
                target:
                  params.target && !params.target.accountId
                    ? ({ ...params.target, accountId: connectorAccountId } as TargetInfo)
                    : params.target,
              }
            ),
          searchMessages: (context, params) =>
            service.searchConnectorMessages(
              {
                ...context,
                accountId: context.accountId ?? connectorAccountId,
                target:
                  context.target && !context.target.accountId
                    ? ({ ...context.target, accountId: connectorAccountId } as TargetInfo)
                    : context.target,
              },
              {
                ...params,
                target:
                  params.target && !params.target.accountId
                    ? ({ ...params.target, accountId: connectorAccountId } as TargetInfo)
                    : params.target,
              }
            ),
          reactHandler: (handlerRuntime, params) =>
            service.reactConnectorMessage(handlerRuntime, {
              ...params,
              target: params.target
                ? params.target.accountId
                  ? params.target
                  : ({ ...params.target, accountId: connectorAccountId } as TargetInfo)
                : ({
                    source: SIGNAL_SERVICE_NAME,
                    accountId: connectorAccountId,
                    channelId: params.channelId,
                    roomId: params.roomId,
                  } as TargetInfo),
            }),
          getUser: service.getConnectorUser.bind(service),
          getChatContext: async (target, context) => {
            const targetAccountId = service.normalizeAccountId(
              target.accountId ?? context.accountId ?? connectorAccountId
            );
            const room = target.roomId ? await context.runtime.getRoom(target.roomId) : null;
            const channelId = String(target.channelId ?? room?.channelId ?? "").trim();
            if (!channelId) {
              return null;
            }

            const recentMessages = (
              await service.getRecentMessages(50, targetAccountId).catch(() => [])
            )
              .filter((recent) => recent.channelId === channelId || recent.roomId === target.roomId)
              .slice(0, 10)
              .map((recent) => ({
                name: recent.speakerName,
                text: recent.text,
                timestamp: recent.createdAt,
                metadata: {
                  accountId: targetAccountId,
                  isFromAgent: recent.isFromAgent,
                  isGroup: recent.isGroup,
                },
              }));

            return {
              target: {
                source: SIGNAL_SERVICE_NAME,
                accountId: targetAccountId,
                roomId: target.roomId,
                channelId,
              },
              label: room?.name || channelId,
              recentMessages,
              metadata: {
                accountId: targetAccountId,
                isGroup: room?.type === ChannelType.GROUP,
                channelId,
              },
            } satisfies MessageConnectorChatContext;
          },
          getUserContext: async (entityId) => {
            const contacts = await service.listConnectorContacts(connectorAccountId);
            const contact = contacts.find(
              (candidate) => service.getEntityId(candidate.number, connectorAccountId) === entityId
            );
            if (!contact) {
              return null;
            }
            return {
              entityId,
              label: getSignalContactDisplayName(contact),
              aliases: [contact.name, contact.profileName, contact.number].filter(
                (value): value is string => typeof value === "string" && value.length > 0
              ),
              handles: {
                signal: contact.number,
              },
              metadata: {
                accountId: connectorAccountId,
                uuid: contact.uuid,
                blocked: contact.blocked,
              },
            } satisfies MessageConnectorUserContext;
          },
        };
        runtime.registerMessageConnector(registration);
      }
      return;
    }

    runtime.registerSendHandler(SIGNAL_SERVICE_NAME, sendHandler);
  }

  private async initialize(): Promise<void> {
    if (this.clients.size === 0 && this.client) {
      this.clients.set(this.defaultAccountId, this.client);
      if (this.accountNumber) {
        this.accountNumbers.set(this.defaultAccountId, this.accountNumber);
      }
    }
    if (this.clients.size === 0) return;

    this.runtime.logger.info(
      {
        src: "plugin:signal",
        agentId: this.runtime.agentId,
        accountIds: Array.from(this.clients.keys()),
      },
      "Initializing Signal service"
    );

    for (const [accountId, client] of this.clients) {
      // Test connection by getting contacts
      const contacts = await client.getContacts();
      this.runtime.logger.info(
        {
          src: "plugin:signal",
          agentId: this.runtime.agentId,
          accountId,
          contactCount: contacts.length,
        },
        "Signal account connected"
      );

      this.cacheContacts(accountId, contacts);
      this.cacheGroups(accountId, await client.getGroups());
    }

    this.isConnected = true;

    if (this.settings.receiveMode === "on-start") {
      this.startPolling();
    } else {
      this.runtime.logger.info(
        {
          src: "plugin:signal",
          agentId: this.runtime.agentId,
          receiveMode: this.settings.receiveMode,
        },
        "Signal receive polling is manual; LifeOps reads pull from signal-cli directly"
      );
    }
  }

  private async shutdown(): Promise<void> {
    this.stopPolling();
    this.clients.clear();
    this.accountNumbers.clear();
    this.client = null;
    this.isConnected = false;
    if (this.daemonProcess) {
      this.daemonProcess.kill("SIGTERM");
      this.daemonProcess = null;
    }

    this.runtime.logger.info(
      { src: "plugin:signal", agentId: this.runtime.agentId },
      "Signal service stopped"
    );
  }

  private async ensureDaemonRunning(
    cliPath: string,
    authDir: string,
    baseUrl: string,
    startupTimeoutMs: number
  ): Promise<void> {
    const current = await signalCheck(baseUrl, 1_500);
    if (current.ok) {
      return;
    }

    const resolvedCliPath = await resolveSignalCliExecutable({
      cliPath,
      env: process.env,
    });
    if (!resolvedCliPath) {
      throw new Error(missingSignalCliMessage(cliPath));
    }

    fs.mkdirSync(authDir, { recursive: true });
    const httpTarget = new URL(baseUrl).host;
    const daemonArgs = [
      "--config",
      authDir,
      "daemon",
      "--http",
      httpTarget,
      "--receive-mode",
      "on-start",
      "--no-receive-stdout",
    ];
    const child = spawn(resolvedCliPath, daemonArgs, {
      env: buildSignalCliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.daemonProcess = child;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text.length > 0) {
        this.runtime.logger.debug(
          { src: "plugin:signal", agentId: this.runtime.agentId, output: text },
          "signal-cli daemon stdout"
        );
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text.length > 0) {
        this.runtime.logger.info(
          { src: "plugin:signal", agentId: this.runtime.agentId, output: text },
          "signal-cli daemon stderr"
        );
      }
    });

    child.once("exit", (code, signal) => {
      if (this.daemonProcess === child) {
        this.daemonProcess = null;
      }
      this.runtime.logger.warn(
        {
          src: "plugin:signal",
          agentId: this.runtime.agentId,
          code,
          signal,
        },
        "signal-cli daemon exited"
      );
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < startupTimeoutMs) {
      if (child.exitCode !== null) {
        throw new Error(`signal-cli daemon exited before becoming ready (code ${child.exitCode})`);
      }

      const ready = await signalCheck(baseUrl, 1_500);
      if (ready.ok) {
        return;
      }

      await sleep(500);
    }

    throw new Error(
      `signal-cli daemon did not become ready at ${baseUrl} within ${startupTimeoutMs}ms`
    );
  }

  private startPolling(): void {
    if (this.pollInterval || this.eventStreams.size > 0 || this.eventStream) return;

    if (this.clients.size > 0) {
      for (const [accountId, client] of this.clients) {
        const eventStream = createSignalEventStream({
          baseUrl: client.baseUrl,
          account: client.accountNumber,
          onEvent: (event) => {
            const data = parseSignalEventData<unknown>(event.data);
            if (data !== null) {
              this.handleSignalEventPayload(data, accountId);
            }
          },
          onError: (error) => {
            this.runtime.logger.error(
              { src: "plugin:signal", accountId, error: String(error) },
              "Signal event stream error"
            );
          },
        });
        this.eventStreams.set(accountId, eventStream);
        if (accountId === this.defaultAccountId) {
          this.eventStream = eventStream;
        }
        eventStream.start();
      }
      return;
    }

    this.pollInterval = setInterval(async () => {
      await this.pollMessages();
    }, 2000); // Poll every 2 seconds
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.eventStream) {
      this.eventStream.stop();
      this.eventStream = null;
    }
    for (const eventStream of this.eventStreams.values()) {
      eventStream.stop();
    }
    this.eventStreams.clear();
  }

  /**
   * Unwraps signal-cli REST API envelope format into a flat SignalMessage.
   *
   * signal-cli returns `{envelope:{source, sourceNumber, sourceName, dataMessage:{message,...}}}`
   * but the plugin expects flat `{sender, message, timestamp, ...}` objects.
   */
  static unwrapEnvelope(raw: Record<string, unknown>): SignalMessage | null {
    if (!raw || !("envelope" in raw)) return raw as unknown as SignalMessage;

    const env = raw.envelope as Record<string, unknown>;
    const dm = (env.dataMessage || {}) as Record<string, unknown>;
    const groupInfo = dm.groupInfo as Record<string, unknown> | undefined;

    const sender = (env.sourceNumber as string) || (env.source as string);
    const timestamp = (dm.timestamp as number) || (env.timestamp as number);

    // Both sender and timestamp are required to produce a usable message.
    if (!sender || !timestamp) return null;

    return {
      sender,
      senderUuid: env.source as string | undefined,
      message: dm.message as string | undefined,
      timestamp,
      groupId: groupInfo?.groupId as string | undefined,
      attachments: (dm.attachments as SignalAttachment[]) || [],
      reaction: dm.reaction as SignalReactionInfo | undefined,
      expiresInSeconds: (dm.expiresInSeconds as number) || 0,
      viewOnce: (dm.viewOnce as boolean) || false,
      quote: dm.quote as SignalQuote | undefined,
    };
  }

  private async pollMessages(accountId?: string | null): Promise<void> {
    if (this.isPolling) return;

    const entries = accountId
      ? ([[this.normalizeAccountId(accountId), this.getClientForAccount(accountId)]].filter(
          ([, client]) => Boolean(client)
        ) as Array<[string, SignalApiClient]>)
      : Array.from(this.clients.entries());
    if (entries.length === 0 && this.client) {
      entries.push([this.defaultAccountId, this.client]);
    }
    if (entries.length === 0) return;

    this.isPolling = true;

    try {
      for (const [entryAccountId, client] of entries) {
        const rawMessages = (await client.receive()) || [];

        for (const raw of rawMessages) {
          try {
            const msg = SignalService.unwrapEnvelope(raw as unknown as Record<string, unknown>);
            if (!msg) {
              this.runtime.logger.warn(
                { src: "plugin:signal", accountId: entryAccountId },
                "Skipping malformed envelope (missing sender or timestamp)"
              );
              continue;
            }
            await this.handleIncomingMessage(msg, entryAccountId);
          } catch (msgErr) {
            this.runtime.logger.error(
              { src: "plugin:signal", accountId: entryAccountId, error: String(msgErr) },
              "Error handling incoming message"
            );
          }
        }
      }
    } catch (err) {
      this.runtime.logger.error(
        { src: "plugin:signal", error: String(err) },
        "Error polling messages"
      );
    } finally {
      this.isPolling = false;
    }
  }

  private handleSignalEventPayload(raw: unknown, accountId?: string | null): void {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    const payloads = Array.isArray(raw) ? raw : [raw];
    for (const payload of payloads) {
      if (!payload || typeof payload !== "object") {
        continue;
      }
      void (async () => {
        try {
          const msg = SignalService.unwrapEnvelope(payload as Record<string, unknown>);
          if (!msg) {
            this.runtime.logger.warn(
              { src: "plugin:signal" },
              "Skipping malformed Signal event (missing sender or timestamp)"
            );
            return;
          }
          await this.handleIncomingMessage(msg, normalizedAccountId);
        } catch (error) {
          this.runtime.logger.error(
            { src: "plugin:signal", error: String(error) },
            "Error handling Signal event"
          );
        }
      })();
    }
  }

  private async handleIncomingMessage(
    msg: SignalMessage,
    accountId = this.defaultAccountId
  ): Promise<void> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    // Handle reactions separately
    if (msg.reaction) {
      await this.handleReaction(msg, normalizedAccountId);
      return;
    }

    // Skip if no message content
    if (!msg.message && msg.attachments.length === 0) {
      return;
    }

    const isGroupMessage = Boolean(msg.groupId);

    // Check if we should ignore group messages
    if (isGroupMessage && this.settings.shouldIgnoreGroupMessages) {
      return;
    }

    // Ensure entity, room, and world exist before creating memories.
    // Without this, the DB insert fails because the foreign keys don't exist.
    const entityId = this.getEntityId(msg.sender, normalizedAccountId);
    const roomId = await this.getRoomId(msg.sender, msg.groupId, normalizedAccountId);
    const worldId = createUniqueUuid(
      this.runtime,
      normalizedAccountId === DEFAULT_ACCOUNT_ID
        ? "signal-world"
        : `signal-world-${normalizedAccountId}`
    );
    const contact = this.getCachedContact(msg.sender, normalizedAccountId);
    const displayName = contact ? getSignalContactDisplayName(contact) : msg.sender;

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      worldName: "Signal",
      userId: msg.sender as unknown as UUID,
      userName: displayName,
      name: displayName,
      source: "signal",
      type: isGroupMessage ? ChannelType.GROUP : ChannelType.DM,
      channelId: msg.groupId || msg.sender,
      metadata: {
        accountId: normalizedAccountId,
        isGroup: isGroupMessage,
        ...(msg.groupId ? { groupId: msg.groupId } : {}),
        sender: msg.sender,
      },
    });
    await this.ensureRoomExists(msg.sender, msg.groupId, normalizedAccountId);

    // Build memory from message
    const memory = await this.buildMemoryFromMessage(msg, normalizedAccountId);
    if (!memory) return;

    // Store the memory
    await this.runtime.createMemory(memory, "messages");

    // Emit event
    await this.runtime.emitEvent(
      SignalEventTypes.MESSAGE_RECEIVED as string,
      {
        runtime: this.runtime,
        source: "signal",
        accountId: normalizedAccountId,
        message: memory,
      } as unknown as EventPayload
    );

    // Get the room for processMessage; fall back to ensureRoomExists if
    // getRoom returns null (e.g. race condition after ensureConnection).
    let room = await this.runtime.getRoom(roomId);
    if (!room) {
      this.runtime.logger.warn(
        { src: "plugin:signal", accountId: normalizedAccountId, roomId, sender: msg.sender },
        "Room not found after ensureConnection, creating via ensureRoomExists"
      );
      room = await this.ensureRoomExists(msg.sender, msg.groupId, normalizedAccountId);
    }

    // Inbound messages are always ingested (memory + MESSAGE_RECEIVED event)
    // so the user can read history and dispatch sends through LifeOps. The
    // agent only auto-generates a reply when SIGNAL_AUTO_REPLY is explicitly
    // enabled — default-off prevents the runtime from speaking on the user's
    // behalf to real Signal contacts.
    if (this.settings.autoReply && !lifeOpsPassiveConnectorsEnabled(this.runtime)) {
      await this.processMessage(memory, room, msg.sender, msg.groupId, normalizedAccountId);
    }
  }

  private async handleReaction(
    msg: SignalMessage,
    accountId = this.defaultAccountId
  ): Promise<void> {
    if (!msg.reaction) return;

    await this.runtime.emitEvent(
      SignalEventTypes.REACTION_RECEIVED as string,
      {
        runtime: this.runtime,
        source: "signal",
        accountId: this.normalizeAccountId(accountId),
      } as unknown as EventPayload
    );
  }

  private async processMessage(
    memory: Memory,
    room: Room,
    sender: string,
    groupId?: string,
    accountId = this.defaultAccountId
  ): Promise<void> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    const callback: HandlerCallback = async (response: Content): Promise<Memory[]> => {
      if (groupId) {
        await this.sendGroupMessage(groupId, response.text || "", {
          accountId: normalizedAccountId,
        });
      } else {
        await this.sendMessage(sender, response.text || "", {
          accountId: normalizedAccountId,
        });
      }

      // Create memory for the response
      const responseMemory: Memory = {
        id: createUniqueUuid(this.runtime, `signal-response-${Date.now()}`),
        agentId: this.runtime.agentId,
        roomId: room.id,
        entityId: this.runtime.agentId,
        content: {
          text: response.text || "",
          source: "signal",
          inReplyTo: memory.id,
        },
        metadata: {
          accountId: normalizedAccountId,
          source: "signal",
          provider: "signal",
          signal: {
            accountId: normalizedAccountId,
            groupId,
          },
        } as unknown as Memory["metadata"],
        createdAt: Date.now(),
      };

      await this.runtime.createMemory(responseMemory, "messages");

      await this.runtime.emitEvent(
        SignalEventTypes.MESSAGE_SENT as string,
        {
          runtime: this.runtime,
          source: "signal",
          accountId: normalizedAccountId,
        } as unknown as EventPayload
      );

      return [responseMemory];
    };

    const messageService = getMessageService(this.runtime);
    if (messageService) {
      await messageService.handleMessage(this.runtime, memory, callback);
    }
  }

  private async buildMemoryFromMessage(
    msg: SignalMessage,
    accountId = this.defaultAccountId
  ): Promise<Memory | null> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    const roomId = await this.getRoomId(msg.sender, msg.groupId, normalizedAccountId);
    const entityId = this.getEntityId(msg.sender, normalizedAccountId);

    // Get contact info for display name
    const contact = this.getCachedContact(msg.sender, normalizedAccountId);
    const displayName = contact ? getSignalContactDisplayName(contact) : msg.sender;

    // Extract media from attachments
    const media: Media[] = (msg.attachments || []).map((att) => ({
      id: att.id,
      url: `signal://attachment/${att.id}`,
      title: att.filename || att.id,
      source: "signal",
      description: att.caption || att.filename,
      contentType: att.contentType as ContentType | undefined,
    }));

    const memory: Memory = {
      id: createUniqueUuid(this.runtime, `signal-${msg.timestamp}`),
      agentId: this.runtime.agentId,
      roomId,
      entityId,
      content: {
        text: msg.message || "",
        source: "signal",
        name: displayName,
        ...(media.length > 0 ? { attachments: media } : {}),
      },
      metadata: {
        type: "message",
        source: "signal",
        provider: "signal",
        accountId: normalizedAccountId,
        timestamp: msg.timestamp,
        entityName: displayName,
        entityUserName: msg.sender,
        fromBot: false,
        fromId: msg.sender,
        sourceId: entityId,
        chatType: msg.groupId ? ChannelType.GROUP : ChannelType.DM,
        messageIdFull: String(msg.timestamp),
        sender: {
          id: msg.sender,
          name: displayName,
          username: msg.sender,
        },
        signal: {
          accountId: normalizedAccountId,
          id: msg.sender,
          userId: msg.sender,
          username: msg.sender,
          userName: msg.sender,
          name: displayName,
          senderId: msg.sender,
          groupId: msg.groupId,
          timestamp: msg.timestamp,
        },
      } as unknown as Memory["metadata"],
      createdAt: msg.timestamp,
    };

    return memory;
  }

  private async getRoomId(
    sender: string,
    groupId?: string,
    accountId = this.defaultAccountId
  ): Promise<UUID> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    const roomKey = groupId || sender;
    return createUniqueUuid(
      this.runtime,
      this.accountScopedKey(normalizedAccountId, "room", roomKey)
    );
  }

  private getEntityId(number: string, accountId = this.defaultAccountId): UUID {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    return normalizedAccountId === DEFAULT_ACCOUNT_ID
      ? stringToUuid(`signal-user-${number}`)
      : stringToUuid(`signal-user-${normalizedAccountId}-${number}`);
  }

  private async ensureRoomExists(
    sender: string,
    groupId?: string,
    accountId = this.defaultAccountId
  ): Promise<Room> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    const roomId = await this.getRoomId(sender, groupId, normalizedAccountId);

    const existingRoom = await this.runtime.getRoom(roomId);

    const isGroup = Boolean(groupId);
    const group = groupId ? this.getCachedGroupForAccount(groupId, normalizedAccountId) : null;
    const contact = this.getCachedContact(sender, normalizedAccountId);
    const worldId = createUniqueUuid(
      this.runtime,
      normalizedAccountId === DEFAULT_ACCOUNT_ID
        ? "signal-world"
        : `signal-world-${normalizedAccountId}`
    );

    const room: Room = {
      id: roomId,
      name: isGroup
        ? group?.name || `Signal Group ${groupId}`
        : contact
          ? getSignalContactDisplayName(contact)
          : sender,
      agentId: this.runtime.agentId,
      source: "signal",
      type: isGroup ? ChannelType.GROUP : ChannelType.DM,
      channelId: groupId || sender,
      worldId,
      metadata: {
        ...(existingRoom?.metadata as Record<string, unknown> | undefined),
        accountId: normalizedAccountId,
        isGroup,
        groupId,
        sender,
        groupName: group?.name,
        groupDescription: group?.description,
      },
    };

    if (typeof this.runtime.ensureRoomExists === "function") {
      await this.runtime.ensureRoomExists(room);
    } else if (!existingRoom) {
      await this.runtime.createRoom(room);
    }

    return room;
  }

  async sendMessage(
    recipient: string,
    text: string,
    options?: SignalMessageSendOptions
  ): Promise<{ timestamp: number }> {
    const accountId = this.normalizeAccountId(options?.accountId);
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Signal client not initialized");
    }

    // signal-cli may identify senders by UUID instead of phone number.
    // Accept both UUID and E.164 formats.
    const normalizedRecipient = isValidUuid(recipient) ? recipient : normalizeE164(recipient);
    if (!normalizedRecipient) {
      throw new Error(`Invalid recipient number: ${recipient}`);
    }

    // Split message if too long
    const messages = this.splitMessage(text);
    let lastTimestamp = 0;

    for (let i = 0; i < messages.length; i++) {
      // Only send attachments/quote with the first chunk
      const chunkOptions = i === 0 ? options : undefined;
      const result = await client.sendMessage(normalizedRecipient, messages[i], chunkOptions);
      lastTimestamp = result.timestamp;
    }

    if (options?.record !== false) {
      await this.recordOutgoingMessage({
        accountId,
        channelId: normalizedRecipient,
        text,
        timestamp: lastTimestamp,
        isGroup: false,
      });
    }

    return { timestamp: lastTimestamp };
  }

  async sendGroupMessage(
    groupId: string,
    text: string,
    options?: SignalMessageSendOptions
  ): Promise<{ timestamp: number }> {
    const accountId = this.normalizeAccountId(options?.accountId);
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Signal client not initialized");
    }

    // Split message if too long
    const messages = this.splitMessage(text);
    let lastTimestamp = 0;

    for (let i = 0; i < messages.length; i++) {
      // Only send attachments with the first chunk
      const chunkOptions = i === 0 ? options : undefined;
      const result = await client.sendGroupMessage(groupId, messages[i], chunkOptions);
      lastTimestamp = result.timestamp;
    }

    if (options?.record !== false) {
      await this.recordOutgoingMessage({
        accountId,
        channelId: groupId,
        text,
        timestamp: lastTimestamp,
        isGroup: true,
      });
    }

    return { timestamp: lastTimestamp };
  }

  async sendDirectMessage(target: string, content: Content): Promise<void> {
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }
    await this.sendMessage(target, text);
  }

  async sendRoomMessage(target: string, content: Content): Promise<void> {
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }
    if (isValidGroupId(target)) {
      await this.sendGroupMessage(target, text);
      return;
    }
    await this.sendMessage(target, text);
  }

  private async recordOutgoingMessage(args: {
    accountId?: string;
    channelId: string;
    text: string;
    timestamp: number;
    isGroup: boolean;
  }): Promise<void> {
    const accountId = this.normalizeAccountId(args.accountId);
    const roomId = await this.getRoomId(
      args.isGroup ? this.getAccountNumberForAccount(accountId) || "signal-agent" : args.channelId,
      args.isGroup ? args.channelId : undefined,
      accountId
    );
    const worldId = createUniqueUuid(
      this.runtime,
      accountId === DEFAULT_ACCOUNT_ID ? "signal-world" : `signal-world-${accountId}`
    );
    const displayName = this.character?.name || "Agent";

    await this.runtime.ensureConnection({
      entityId: this.runtime.agentId,
      roomId,
      worldId,
      worldName: "Signal",
      userId: this.runtime.agentId,
      userName: displayName,
      name: displayName,
      source: "signal",
      type: args.isGroup ? ChannelType.GROUP : ChannelType.DM,
      channelId: args.channelId,
      metadata: {
        accountId,
        isGroup: args.isGroup,
        channelId: args.channelId,
      },
    });

    const memory = createMessageMemory({
      id: createUniqueUuid(this.runtime, `signal:${args.timestamp}`),
      entityId: this.runtime.agentId,
      roomId,
      content: {
        text: args.text,
        source: "signal",
      },
    });
    await this.runtime.createMemory(
      {
        ...memory,
        metadata: {
          ...(memory.metadata ?? {}),
          accountId,
          source: "signal",
          provider: "signal",
          timestamp: args.timestamp,
          messageIdFull: String(args.timestamp),
          signal: {
            accountId,
            timestamp: args.timestamp,
          },
        } as unknown as Memory["metadata"],
        createdAt: args.timestamp,
      },
      "messages"
    );
  }

  async sendReaction(
    recipient: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string,
    accountId?: string
  ): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Signal client not initialized");
    }

    await client.sendReaction(recipient, emoji, targetTimestamp, targetAuthor);
  }

  async removeReaction(
    recipient: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string,
    accountId?: string
  ): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) {
      throw new Error("Signal client not initialized");
    }

    await client.sendReaction(recipient, emoji, targetTimestamp, targetAuthor, true);
  }

  async getContacts(accountId?: string): Promise<SignalContact[]> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    const client = this.getClientForAccount(normalizedAccountId);
    if (!client) {
      throw new Error("Signal client not initialized");
    }

    const contacts = await client.getContacts();

    this.cacheContacts(normalizedAccountId, contacts);

    return contacts;
  }

  private async listConnectorContacts(accountId?: string): Promise<SignalContact[]> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    try {
      return await this.getContacts(normalizedAccountId);
    } catch {
      return Array.from(
        this.contactCaches.get(normalizedAccountId)?.values() ?? this.contactCache.values()
      );
    }
  }

  async getGroups(accountId?: string): Promise<SignalGroup[]> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    const client = this.getClientForAccount(normalizedAccountId);
    if (!client) {
      throw new Error("Signal client not initialized");
    }

    const groups = await client.getGroups();

    this.cacheGroups(normalizedAccountId, groups);

    return groups;
  }

  private async listConnectorGroups(accountId?: string): Promise<SignalGroup[]> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    try {
      return await this.getGroups(normalizedAccountId);
    } catch {
      return Array.from(
        this.groupCaches.get(normalizedAccountId)?.values() ?? this.groupCache.values()
      );
    }
  }

  private roomMatchesAccount(room: Room, accountId: string): boolean {
    const metadata = room.metadata as Record<string, unknown> | undefined;
    const roomAccountId =
      typeof metadata?.accountId === "string" && metadata.accountId.trim()
        ? this.normalizeAccountId(metadata.accountId)
        : undefined;
    return roomAccountId ? roomAccountId === accountId : accountId === DEFAULT_ACCOUNT_ID;
  }

  private memoryMatchesAccount(memory: Memory, accountId: string): boolean {
    const metadata = memory.metadata as Record<string, unknown> | undefined;
    const memoryAccountId =
      typeof metadata?.accountId === "string" && metadata.accountId.trim()
        ? this.normalizeAccountId(metadata.accountId)
        : undefined;
    return memoryAccountId ? memoryAccountId === accountId : accountId === DEFAULT_ACCOUNT_ID;
  }

  async getRecentMessages(
    limit: number = 20,
    accountId = this.defaultAccountId
  ): Promise<SignalRecentMessage[]> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    if (
      typeof this.runtime.getRoomsForParticipant !== "function" ||
      typeof this.runtime.getMemoriesByRoomIds !== "function"
    ) {
      return [];
    }

    const requestedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 20;
    const participantRoomIds = await this.runtime.getRoomsForParticipant(this.runtime.agentId);

    const signalRooms: Room[] = [];
    for (const roomId of participantRoomIds) {
      const room = await this.runtime.getRoom(roomId);
      if (room?.source === "signal" && this.roomMatchesAccount(room, normalizedAccountId)) {
        signalRooms.push(room);
      }
    }

    if (signalRooms.length === 0) {
      return [];
    }

    const roomIds = signalRooms.map((room) => room.id);
    const roomsById = new Map(signalRooms.map((room) => [room.id, room]));
    const memories = await this.runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds,
      limit: requestedLimit * 4,
    });

    return memories
      .filter((memory) => memory.content?.source === "signal")
      .filter((memory) => this.memoryMatchesAccount(memory, normalizedAccountId))
      .filter(
        (memory) =>
          typeof memory.content?.text === "string" && memory.content.text.trim().length > 0
      )
      .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
      .slice(0, requestedLimit)
      .map((memory) => {
        const room = roomsById.get(memory.roomId);
        const isGroup =
          room?.type === ChannelType.GROUP ||
          Boolean((room?.metadata as Record<string, unknown> | undefined)?.isGroup);
        const text = String(memory.content.text ?? "").trim();
        const speakerName =
          memory.entityId === this.runtime.agentId
            ? this.character?.name || "Agent"
            : typeof memory.content.name === "string" && memory.content.name.trim().length > 0
              ? memory.content.name.trim()
              : room?.name || room?.channelId || "Unknown";

        return {
          id: String(memory.id),
          roomId: String(memory.roomId),
          channelId: String(room?.channelId ?? ""),
          roomName: room?.name || room?.channelId || "Signal",
          speakerName,
          text,
          createdAt: Number(memory.createdAt ?? Date.now()),
          isFromAgent: memory.entityId === this.runtime.agentId,
          isGroup,
        } satisfies SignalRecentMessage;
      });
  }

  private async getSignalRooms(
    channelId?: string,
    roomId?: UUID,
    accountId = this.defaultAccountId
  ): Promise<Room[]> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    if (roomId) {
      const room = await this.runtime.getRoom(roomId);
      return room?.source === "signal" && this.roomMatchesAccount(room, normalizedAccountId)
        ? [room]
        : [];
    }

    if (
      typeof this.runtime.getRoomsForParticipant !== "function" ||
      typeof this.runtime.getRoom !== "function"
    ) {
      return [];
    }

    const participantRoomIds = await this.runtime.getRoomsForParticipant(this.runtime.agentId);
    const rooms: Room[] = [];
    for (const participantRoomId of participantRoomIds) {
      const room = await this.runtime.getRoom(participantRoomId);
      if (room?.source !== "signal") {
        continue;
      }
      if (!this.roomMatchesAccount(room, normalizedAccountId)) {
        continue;
      }
      if (channelId && room.channelId !== channelId) {
        continue;
      }
      rooms.push(room);
    }
    return rooms;
  }

  async fetchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: ConnectorFetchMessagesParams
  ): Promise<Memory[]> {
    if (typeof this.runtime.getMemoriesByRoomIds !== "function") {
      return [];
    }

    const target = params.target ?? context.target;
    const accountId = this.normalizeAccountId(target?.accountId ?? context.accountId);
    const channelId = params.channelId ?? target?.channelId;
    const roomId = params.roomId ?? target?.roomId;
    const rooms = await this.getSignalRooms(channelId, roomId, accountId);
    if (rooms.length === 0) {
      return [];
    }

    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Number(params.limit), 100))
      : 25;
    const memories = await this.runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: rooms.map((room) => room.id),
      limit: limit * Math.max(rooms.length, 1),
    });
    const before = params.before ? Number(params.before) : undefined;
    const after = params.after ? Number(params.after) : undefined;

    return memories
      .filter((memory) => memory.content?.source === "signal")
      .filter((memory) => this.memoryMatchesAccount(memory, accountId))
      .filter((memory) => {
        const createdAt = Number(memory.createdAt ?? 0);
        if (before !== undefined && Number.isFinite(before) && createdAt >= before) {
          return false;
        }
        if (after !== undefined && Number.isFinite(after) && createdAt <= after) {
          return false;
        }
        return true;
      })
      .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
      .slice(0, limit);
  }

  async searchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: ConnectorSearchMessagesParams
  ): Promise<Memory[]> {
    const query = params.query?.trim().toLowerCase();
    if (!query) {
      return [];
    }
    const memories = await this.fetchConnectorMessages(context, {
      ...params,
      limit: Math.max(params.limit ?? 100, 100),
    });
    return memories
      .filter((memory) => {
        const text = String(memory.content?.text ?? "").toLowerCase();
        const name = String(memory.content?.name ?? "").toLowerCase();
        return text.includes(query) || name.includes(query);
      })
      .slice(0, params.limit ?? 25);
  }

  async reactConnectorMessage(
    runtime: IAgentRuntime,
    params: ConnectorReactionParams
  ): Promise<void> {
    const target = params.target;
    const accountId = this.normalizeAccountId(target?.accountId);
    const room =
      params.roomId || target?.roomId
        ? await runtime.getRoom((params.roomId ?? target?.roomId) as UUID)
        : null;
    const recipient = params.channelId ?? target?.channelId ?? room?.channelId;
    if (!recipient) {
      throw new Error("Signal reaction requires a target recipient or room.");
    }

    let targetTimestamp = params.targetTimestamp;
    let targetAuthor = params.targetAuthor;
    if ((!targetTimestamp || !targetAuthor) && params.messageId) {
      const memory = await runtime.getMemoryById(params.messageId as UUID).catch(() => null);
      const metadata = memory?.metadata as Record<string, unknown> | undefined;
      const sender = metadata?.sender as Record<string, unknown> | undefined;
      targetTimestamp =
        targetTimestamp ??
        Number(metadata?.messageIdFull ?? metadata?.timestamp ?? memory?.createdAt);
      targetAuthor =
        targetAuthor ??
        (typeof sender?.id === "string"
          ? sender.id
          : typeof metadata?.fromId === "string"
            ? metadata.fromId
            : undefined);
    }

    if (!params.emoji || !targetTimestamp || !targetAuthor) {
      throw new Error("Signal reaction requires emoji, targetTimestamp, and targetAuthor.");
    }

    if (params.remove) {
      await this.removeReaction(recipient, params.emoji, targetTimestamp, targetAuthor, accountId);
      return;
    }
    await this.sendReaction(recipient, params.emoji, targetTimestamp, targetAuthor, accountId);
  }

  async getConnectorUser(
    _runtime: IAgentRuntime,
    params: ConnectorUserLookupParams
  ): Promise<unknown> {
    const lookup = params.userId ?? params.handle ?? params.username ?? params.query;
    if (!lookup) {
      return null;
    }
    const accountId = this.normalizeAccountId(params.target?.accountId);
    const contacts = await this.listConnectorContacts(accountId);
    const normalizedLookup = normalizeSignalQuery(lookup);
    const contact = contacts.find((candidate) =>
      [candidate.number, candidate.uuid, candidate.name, candidate.profileName]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .some((value) => normalizeSignalQuery(value).includes(normalizedLookup))
    );
    if (!contact) {
      return null;
    }
    const label = getSignalContactDisplayName(contact);
    return {
      id: this.getEntityId(contact.number, accountId),
      agentId: this.runtime.agentId,
      names: [label, contact.name, contact.profileName, contact.number].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      ),
      metadata: {
        source: "signal",
        accountId,
        signal: {
          accountId,
          number: contact.number,
          uuid: contact.uuid,
          blocked: contact.blocked,
        },
      },
    };
  }

  async getGroup(groupId: string, accountId?: string): Promise<SignalGroup | null> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    const client = this.getClientForAccount(normalizedAccountId);
    if (!client) {
      throw new Error("Signal client not initialized");
    }

    const group = await client.getGroup(groupId);
    if (group) {
      this.cacheGroups(normalizedAccountId, [group]);
    }

    return group;
  }

  async sendTypingIndicator(recipient: string, accountId?: string): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) return;
    await client.sendTyping(recipient);
  }

  async stopTypingIndicator(recipient: string, accountId?: string): Promise<void> {
    const client = this.getClientForAccount(accountId);
    if (!client) return;
    await client.sendTyping(recipient, true);
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_SIGNAL_MESSAGE_LENGTH) {
      return [text];
    }

    const messages: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_SIGNAL_MESSAGE_LENGTH) {
        messages.push(remaining);
        break;
      }

      let splitIndex = MAX_SIGNAL_MESSAGE_LENGTH;

      const lastNewline = remaining.lastIndexOf("\n", MAX_SIGNAL_MESSAGE_LENGTH);
      if (lastNewline > MAX_SIGNAL_MESSAGE_LENGTH / 2) {
        splitIndex = lastNewline + 1;
      } else {
        const lastSpace = remaining.lastIndexOf(" ", MAX_SIGNAL_MESSAGE_LENGTH);
        if (lastSpace > MAX_SIGNAL_MESSAGE_LENGTH / 2) {
          splitIndex = lastSpace + 1;
        }
      }

      messages.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);
    }

    return messages;
  }

  getContact(number: string): SignalContact | null {
    return this.contactCache.get(number) || null;
  }

  getCachedGroup(groupId: string): SignalGroup | null {
    return this.groupCache.get(groupId) || null;
  }

  getAccountNumber(): string | null {
    return this.accountNumber;
  }

  isServiceConnected(): boolean {
    return this.isConnected;
  }
}
