/**
 * Owns live, identity-verified personal Telegram clients and their read-only
 * connectors. Sessions are isolated by agent/account; owner policy is checked
 * before each history page and stale lifecycle generations cannot return data.
 */

import { createHash } from "node:crypto";
import {
  createUniqueUuid,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
  type Memory,
  type MessageConnectorQueryContext,
  Service,
  type TargetInfo,
  validateUuid,
} from "@elizaos/core";
import { Api, TelegramClient } from "telegram";
import { returnBigInt } from "telegram/Helpers.js";
import { StringSession } from "telegram/sessions/index.js";
import { getPeerId } from "telegram/Utils.js";
import {
  defaultTelegramAccountDeviceModel,
  defaultTelegramAccountSystemVersion,
  loadTelegramAccountSessionString,
  saveTelegramAccountSessionString,
  type TelegramAccountApiCredentials,
  type TelegramAccountAuthAccount,
} from "./account-auth-service";
import { resolveTelegramAppCredentials } from "./account-credentials.js";
import {
  readTelegramAccountHistory,
  type TelegramHistoryQuery,
} from "./account-history";
import {
  DEFAULT_ACCOUNT_ID,
  listPersonalTelegramAccounts,
  type ResolvedTelegramAccount,
} from "./accounts";
import { resolveTelegramRuntimeEntityId } from "./identity";

export const TELEGRAM_PERSONAL_SERVICE_TYPE = "telegram-account";
export const TELEGRAM_PERSONAL_ACCOUNT_SUFFIX = ":personal";

type ClientEntry = {
  client: TelegramClient;
  summary: TelegramAccountAuthAccount;
  generation: number;
  fingerprint: string;
};
export interface TelegramAccountClientDeps {
  createClient?: (
    session: StringSession,
    credentials: TelegramAccountApiCredentials,
    deviceModel: string,
    systemVersion: string,
  ) => TelegramClient;
}
export interface TelegramAccountReadParams extends TelegramHistoryQuery {
  target?: TargetInfo;
  accountId?: string;
  query?: string;
  channelId?: string;
  roomId?: string;
}

function fingerprint(account: ResolvedTelegramAccount): string {
  return createHash("sha256")
    .update(JSON.stringify(account.config.personal))
    .digest("hex");
}
function phoneIdentity(phone: string): string {
  return phone.replace(/[ ()-]/g, "").replace(/^\+/, "");
}
function serialize(client: TelegramClient): string {
  const session = client.session.save();
  if (typeof session !== "string" || !session) {
    throw new ElizaError(
      "Telegram did not provide a reusable authorized session. Reconnect the account.",
      { code: "TELEGRAM_SESSION_INVALID" },
    );
  }
  return session;
}

export class TelegramAccountService extends Service {
  static serviceType = TELEGRAM_PERSONAL_SERVICE_TYPE;
  capabilityDescription =
    "Read complete personal Telegram history with verified account ownership.";
  private readonly clients = new Map<string, ClientEntry>();
  private readonly generations = new Map<string, number>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, Error>();
  private stopped = false;
  private readonly createClient: NonNullable<
    TelegramAccountClientDeps["createClient"]
  >;

  constructor(runtime?: IAgentRuntime, deps: TelegramAccountClientDeps = {}) {
    if (!runtime)
      throw new ElizaError("Start personal Telegram with its owning runtime.", {
        code: "TELEGRAM_RUNTIME_REQUIRED",
      });
    super(runtime);
    this.createClient =
      deps.createClient ??
      ((session, credentials, deviceModel, systemVersion) =>
        new TelegramClient(session, credentials.apiId, credentials.apiHash, {
          deviceModel,
          systemVersion,
          connectionRetries: 3,
          floodSleepThreshold: 0,
        }));
  }

  static async start(runtime: IAgentRuntime): Promise<TelegramAccountService> {
    const service = new TelegramAccountService(runtime);
    for (const account of listPersonalTelegramAccounts(runtime)) {
      try {
        await service.refreshAccount(
          `${account.accountId}${TELEGRAM_PERSONAL_ACCOUNT_SUFFIX}`,
        );
      } catch (error) {
        // error-policy:J4 account health remains explicitly error; other connectors can start.
        runtime.reportError("telegram-account.start", error, {
          accountId: account.accountId,
        });
      }
    }
    return service;
  }

  private configured(accountId: string): ResolvedTelegramAccount | undefined {
    return listPersonalTelegramAccounts(this.runtime).find(
      (account) =>
        `${account.accountId}${TELEGRAM_PERSONAL_ACCOUNT_SUFFIX}` === accountId,
    );
  }
  private nextGeneration(accountId: string): number {
    const generation = (this.generations.get(accountId) ?? 0) + 1;
    this.generations.set(accountId, generation);
    return generation;
  }
  private queue(
    accountId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const pending = (this.operations.get(accountId) ?? Promise.resolve()).then(
      operation,
    );
    // error-policy:J5 caller observes pending; the serialization tail only waits for settlement.
    this.operations.set(
      accountId,
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
    return pending;
  }
  private async disconnect(accountId: string): Promise<void> {
    this.runtime.unregisterMessageConnector("telegram", accountId);
    const entry = this.clients.get(accountId);
    if (entry) {
      try {
        await entry.client.disconnect();
      } catch (cause) {
        // error-policy:J2 retain the client for another stop attempt; it remains inadmissible.
        const error = new ElizaError(
          "Telegram personal client could not disconnect. Retry stopping this account before reconnecting.",
          { code: "TELEGRAM_ACCOUNT_DISCONNECT_FAILED", cause },
        );
        this.failures.set(accountId, error);
        throw error;
      }
      this.clients.delete(accountId);
    }
  }
  async stopAccount(
    accountId = `${DEFAULT_ACCOUNT_ID}${TELEGRAM_PERSONAL_ACCOUNT_SUFFIX}`,
  ): Promise<void> {
    this.nextGeneration(accountId);
    await this.queue(accountId, () => this.disconnect(accountId));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...new Set([...this.clients.keys(), ...this.operations.keys()])].map(
        (accountId) => this.stopAccount(accountId),
      ),
    );
  }

  async refreshAccount(
    accountId = `${DEFAULT_ACCOUNT_ID}${TELEGRAM_PERSONAL_ACCOUNT_SUFFIX}`,
  ): Promise<void> {
    if (this.stopped)
      throw new ElizaError(
        "Telegram personal service has stopped. Restart the runtime to reconnect.",
        { code: "TELEGRAM_ACCOUNT_NOT_CONNECTED" },
      );
    const generation = this.nextGeneration(accountId);
    return this.queue(accountId, async () => {
      await this.disconnect(accountId);
      this.failures.delete(accountId);
      const account = this.configured(accountId);
      if (!account) return;
      const personal = account.config.personal;
      if (!personal) return;
      let client: TelegramClient | undefined;
      try {
        const credentials = personal.appHash?.startsWith("vault://")
          ? resolveTelegramAppCredentials(this.runtime, personal, true)
          : { apiId: Number(personal.appId), apiHash: personal.appHash };
        const { apiId, apiHash } = credentials;
        if (
          !Number.isSafeInteger(apiId) ||
          apiId < 1 ||
          !apiHash ||
          !personal.phone
        ) {
          throw new ElizaError(
            "Configure the phone and Telegram application credentials before connecting personal history.",
            { code: "TELEGRAM_ACCOUNT_CONFIG_INVALID" },
          );
        }
        const scope = { agentId: String(this.runtime.agentId), accountId };
        const saved =
          loadTelegramAccountSessionString(scope) || personal.session;
        if (!saved) return;
        client = this.createClient(
          new StringSession(saved),
          { apiId, apiHash },
          personal.deviceModel ?? defaultTelegramAccountDeviceModel(),
          personal.systemVersion ?? defaultTelegramAccountSystemVersion(),
        );
        await client.connect();
        if (!(await client.checkAuthorization()))
          throw new ElizaError(
            "Telegram authorization expired. Reconnect this personal account.",
            { code: "TELEGRAM_ACCOUNT_AUTH_REQUIRED" },
          );
        const user = await client.getMe();
        if (
          !(user instanceof Api.User) ||
          !user.phone ||
          phoneIdentity(user.phone) !== phoneIdentity(personal.phone) ||
          (personal.subjectId !== undefined &&
            personal.subjectId !== user.id.toString())
        ) {
          throw new ElizaError(
            "The saved Telegram session does not match this configured account. Reconnect the intended account.",
            { code: "TELEGRAM_ACCOUNT_IDENTITY_MISMATCH" },
          );
        }
        const current = this.configured(accountId);
        if (
          this.stopped ||
          this.generations.get(accountId) !== generation ||
          !current ||
          fingerprint(current) !== fingerprint(account)
        ) {
          throw new ElizaError(
            "Telegram account changed while connecting. Retry with the current account.",
            { code: "TELEGRAM_ACCOUNT_CHANGED" },
          );
        }
        saveTelegramAccountSessionString(serialize(client), scope);
        const summary = {
          id: user.id.toString(),
          username: user.username ?? null,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
          phone: user.phone,
        };
        this.clients.set(accountId, {
          client,
          summary,
          generation,
          fingerprint: fingerprint(account),
        });
        this.runtime.registerMessageConnector({
          source: "telegram",
          accountId,
          account: {
            source: "telegram",
            accountId,
            role: "OWNER",
            authMethod: "SESSION",
          },
          label: account.name ?? "Telegram personal account",
          capabilities: ["read_messages", "search_messages"],
          supportedTargetKinds: ["user", "channel", "thread"],
          contexts: [],
          fetchMessages: (context, params) =>
            this.fetchConnectorMessages(context, params),
          searchMessages: (context, params) =>
            this.searchConnectorMessages(context, params),
        });
      } catch (cause) {
        // error-policy:J2 connection failures retain typed cause and explicit account health.
        const error =
          cause instanceof ElizaError
            ? cause
            : new ElizaError(
                "Telegram personal connection failed. Reconnect this account.",
                {
                  code: "TELEGRAM_ACCOUNT_CONNECT_FAILED",
                  cause,
                  context: { accountId },
                },
              );
        this.failures.set(accountId, error);
        this.clients.delete(accountId);
        try {
          if (client) await client.disconnect();
        } catch (error) {
          // error-policy:J6 failed connection teardown is reported without masking its original failure.
          this.runtime.reportError("telegram-account.disconnect", error, {
            accountId,
          });
        }
        throw error;
      }
    });
  }

  getAccountStatus(accountId: string): "connected" | "pending" | "error" {
    if (this.isConnected(accountId)) return "connected";
    return this.failures.has(accountId) ? "error" : "pending";
  }
  getAccountError(
    accountId = `${DEFAULT_ACCOUNT_ID}${TELEGRAM_PERSONAL_ACCOUNT_SUFFIX}`,
  ): string | null {
    const error = this.failures.get(accountId);
    if (!error) return null;
    return error instanceof ElizaError
      ? error.message
      : "Telegram personal connection failed. Reconnect the account.";
  }
  isConnected(
    accountId = `${DEFAULT_ACCOUNT_ID}${TELEGRAM_PERSONAL_ACCOUNT_SUFFIX}`,
  ): boolean {
    const entry = this.clients.get(accountId);
    const configured = this.configured(accountId);
    return (
      !this.stopped &&
      !!entry &&
      !!configured &&
      entry.generation === this.generations.get(accountId) &&
      entry.fingerprint === fingerprint(configured)
    );
  }
  getAccountSummary(
    accountId = `${DEFAULT_ACCOUNT_ID}${TELEGRAM_PERSONAL_ACCOUNT_SUFFIX}`,
  ): TelegramAccountAuthAccount | null {
    const summary = this.isConnected(accountId)
      ? this.clients.get(accountId)?.summary
      : null;
    return summary ? { ...summary } : null;
  }

  private selectedAccount(
    context: MessageConnectorQueryContext,
    params: TelegramAccountReadParams,
  ): string {
    const identities = [
      context.accountId,
      context.account?.accountId,
      context.target?.accountId,
      params.accountId,
      params.target?.accountId,
    ].filter((id): id is string => id !== undefined);
    if (
      context.runtime !== this.runtime ||
      identities.length === 0 ||
      new Set(identities).size !== 1 ||
      !identities[0].endsWith(TELEGRAM_PERSONAL_ACCOUNT_SUFFIX)
    ) {
      throw new ElizaError(
        "Select one exact personal Telegram account for this read.",
        { code: "TELEGRAM_ACCOUNT_MISMATCH" },
      );
    }
    return identities[0];
  }
  private async admission(
    accountId: string,
    entry: ClientEntry,
  ): Promise<void> {
    if (!this.isConnected(accountId) || this.clients.get(accountId) !== entry)
      throw new ElizaError(
        "Telegram account is disconnected or changed. Reconnect and retry.",
        { code: "TELEGRAM_ACCOUNT_NOT_CONNECTED" },
      );
    const decision = await getConnectorAccountManager(
      this.runtime,
    ).evaluatePolicy(
      {
        provider: "telegram",
        roles: ["OWNER"],
        purposes: ["reading"],
        accessGates: ["owner_binding"],
        statuses: ["connected"],
      },
      { accountId, purpose: "reading" },
    );
    if (!decision.allowed || decision.account?.externalId !== entry.summary.id)
      throw new ElizaError(
        "This Telegram read requires the connected, verified owner account.",
        { code: "TELEGRAM_ACCOUNT_READ_DENIED" },
      );
    if (!this.isConnected(accountId) || this.clients.get(accountId) !== entry)
      throw new ElizaError(
        "Telegram account changed during read admission. Retry.",
        { code: "TELEGRAM_ACCOUNT_NOT_CONNECTED" },
      );
  }
  private async resolveReadTarget(
    context: MessageConnectorQueryContext,
    params: TelegramAccountReadParams,
    accountId: string,
  ): Promise<TargetInfo> {
    const targets = [context.target, params.target];
    if (
      targets.some((target) => target && target.source !== "telegram") ||
      (context.source !== undefined && context.source !== "telegram")
    )
      throw new ElizaError("Select a Telegram conversation for this read.", {
        code: "TELEGRAM_HISTORY_TARGET_INVALID",
      });
    const reconcile = (kind: string, values: Array<string | undefined>) => {
      const supplied = values.filter(
        (value): value is string => value !== undefined,
      );
      if (new Set(supplied).size > 1)
        throw new ElizaError(
          `Telegram ${kind} selectors disagree. Select one conversation.`,
          {
            code: "TELEGRAM_HISTORY_TARGET_INVALID",
          },
        );
      return supplied[0];
    };
    const selectedRoom = reconcile("room", [
      context.target?.roomId,
      params.target?.roomId,
      context.roomId,
      params.roomId,
    ]);
    const channelId = reconcile("peer", [
      context.target?.channelId,
      params.target?.channelId,
      params.channelId,
    ]);
    const threadId = reconcile("thread", [
      context.target?.threadId,
      params.target?.threadId,
      params.threadId === undefined ? undefined : String(params.threadId),
    ]);
    const target = {
      ...context.target,
      ...params.target,
      source: "telegram",
      accountId,
      channelId,
      threadId,
    };
    if (selectedRoom === undefined) return target;
    const rooms = [selectedRoom];
    const roomId = validateUuid(rooms[0]);
    if (!roomId)
      throw new ElizaError(
        "Provide a valid Telegram room ID or its provider channel ID.",
        { code: "TELEGRAM_HISTORY_TARGET_INVALID" },
      );
    const room = await this.runtime.getRoom(roomId);
    if (
      !room ||
      room.source !== "telegram" ||
      room.metadata?.accountId !== accountId ||
      !room.channelId ||
      (channelId !== undefined && channelId !== room.channelId)
    ) {
      throw new ElizaError(
        "This room is not bound to the selected personal Telegram account. Select its provider conversation explicitly.",
        { code: "TELEGRAM_HISTORY_TARGET_INVALID" },
      );
    }
    return {
      ...target,
      source: "telegram",
      accountId,
      roomId,
      channelId: room.channelId,
    };
  }
  async fetchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: TelegramAccountReadParams = {},
  ): Promise<Memory[]> {
    const accountId = this.selectedAccount(context, params);
    const entry = this.clients.get(accountId);
    if (!entry)
      throw new ElizaError(
        "Connect this personal Telegram account before reading history.",
        { code: "TELEGRAM_ACCOUNT_NOT_CONNECTED" },
      );
    await this.admission(accountId, entry);
    const target = await this.resolveReadTarget(context, params, accountId);
    const channel = target.channelId;
    if (!channel)
      throw new ElizaError("Select a Telegram peer/channel for full history.", {
        code: "TELEGRAM_HISTORY_TARGET_REQUIRED",
      });
    const peer = await entry.client.getInputEntity(
      /^-?\d+$/.test(channel) ? returnBigInt(channel) : channel,
    );
    const peerId = getPeerId(peer);
    const thread = target?.threadId;
    try {
      const messages = await readTelegramAccountHistory(
        entry.client,
        peer,
        {
          ...params,
          expectedPeerId: peerId,
          threadId: thread === undefined ? params.threadId : Number(thread),
        },
        () => this.admission(accountId, entry),
      );
      const projected: Memory[] = [];
      for (const message of messages)
        projected.push(await this.project(accountId, peerId, message));
      await this.admission(accountId, entry);
      return projected;
    } catch (cause) {
      // error-policy:J2 provider errors invalidate live health; no successful partial history escapes.
      if (
        cause instanceof ElizaError &&
        cause.code === "TELEGRAM_HISTORY_READ_FAILED" &&
        this.clients.get(accountId) === entry
      ) {
        this.failures.set(accountId, cause);
        try {
          await this.stopAccount(accountId);
        } catch (error) {
          // error-policy:J6 preserve the read failure while reporting failed connection teardown.
          this.runtime.reportError("telegram-account.read.disconnect", error, {
            accountId,
          });
        }
      }
      throw cause;
    }
  }
  async searchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: TelegramAccountReadParams = {},
  ): Promise<Memory[]> {
    if (typeof params.query !== "string" || !params.query.trim())
      throw new ElizaError("Provide a Telegram message search query.", {
        code: "TELEGRAM_HISTORY_QUERY_INVALID",
      });
    const query = params.query.toLocaleLowerCase();
    if (
      params.limit !== undefined &&
      (!Number.isSafeInteger(params.limit) || params.limit < 1)
    )
      throw new ElizaError(
        "Search limit must be a positive integer or omitted.",
        { code: "TELEGRAM_HISTORY_QUERY_INVALID" },
      );
    const accountId = this.selectedAccount(context, params);
    const entry = this.clients.get(accountId);
    if (!entry)
      throw new ElizaError(
        "Connect this personal Telegram account before searching.",
        { code: "TELEGRAM_ACCOUNT_NOT_CONNECTED" },
      );
    await this.admission(accountId, entry);
    const target = await this.resolveReadTarget(context, params, accountId);
    const targets: TargetInfo[] = [];
    if (target?.channelId || params.channelId)
      targets.push({
        ...target,
        source: "telegram",
        accountId,
        channelId: target?.channelId ?? params.channelId,
      });
    else {
      for await (const dialog of entry.client.iterDialogs({})) {
        await this.admission(accountId, entry);
        if (dialog.id)
          targets.push({
            source: "telegram",
            accountId,
            channelId: dialog.id.toString(),
          });
      }
    }
    const found: Memory[] = [];
    for (const selected of targets) {
      const messages = await this.fetchConnectorMessages(
        { ...context, target: selected },
        { ...params, target: selected, limit: undefined },
      );
      for (const message of messages) {
        if (message.content.text?.toLocaleLowerCase().includes(query))
          found.push(message);
      }
    }
    found.sort(
      (a, b) =>
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
    await this.admission(accountId, entry);
    if (params.limit !== undefined) {
      // The caller explicitly requested this result count; omitted limits retain every match.
      return found.slice(0, params.limit);
    }
    return found;
  }
  private async project(
    accountId: string,
    peerId: string,
    message: Api.TypeMessage,
  ): Promise<Memory> {
    const deleted = message instanceof Api.MessageEmpty;
    const senderId =
      !deleted && message.fromId
        ? getPeerId(message.fromId)
        : `service:${peerId}`;
    return {
      id: createUniqueUuid(
        this.runtime,
        `telegram:${accountId}:${peerId}:${message.id}`,
      ),
      agentId: this.runtime.agentId,
      entityId:
        !deleted && message.fromId instanceof Api.PeerUser
          ? await resolveTelegramRuntimeEntityId(
              this.runtime,
              accountId,
              message.fromId.userId.toString(),
            )
          : createUniqueUuid(
              this.runtime,
              `telegram:${accountId}:sender:${senderId}`,
            ),
      roomId: createUniqueUuid(
        this.runtime,
        `telegram:${accountId}:peer:${peerId}`,
      ),
      ...(deleted ? {} : { createdAt: message.date * 1000 }),
      content: {
        text: deleted
          ? "[Deleted Telegram message]"
          : message instanceof Api.MessageService
            ? `[Telegram service event: ${message.action?.className}]`
            : message.message,
        source: "telegram",
      },
      metadata: {
        type: "message",
        scope: "owner-private",
        source: "telegram",
        accountId,
        platformMessageId: String(message.id),
        telegramChatId: peerId,
        fromId: senderId,
        deleted,
        providerMessage: JSON.stringify(message),
      },
    };
  }
}
