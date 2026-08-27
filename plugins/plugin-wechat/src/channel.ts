/**
 * Runtime-owned lifecycle orchestrator for direct-mode WeChat accounts:
 * resolves and validates the direct configuration, starts one public callback
 * server shared by all accounts, verifies transport health via a token probe
 * at startup, and owns outbound sends through the first-party API client.
 * The proxy login/registration flow that previously lived here is deleted;
 * an account whose credentials fail the startup probe is reported
 * unavailable and never fake-healthy.
 */
import { WechatApiClient } from "./api-client";
import { Bot } from "./bot";
import {
  type CallbackServerHandle,
  startCallbackServer,
} from "./callback-server";
import { TokenManager } from "./token-manager";
import type {
  ResolvedWechatAccount,
  WechatAccountConfig,
  WechatConfig,
  WechatMessageContext,
  WechatTransportHealth,
} from "./types";
import { WechatError } from "./types";

const DEFAULT_CALLBACK_PORT = 18790;

/** Observed-target summary consumed by the connector target builders. */
export interface MessageConnectorTargetLite {
  accountId: string;
  platformUserId: string;
  name?: string;
  kind: "user" | "group";
  lastObservedAt: number;
}

interface ObservedSenderEntry {
  name?: string;
  kind: "user" | "group";
  lastObservedAt: number;
  via: string;
}

export interface ChannelOptions {
  config: WechatConfig;
  onMessage: (
    accountId: string,
    msg: WechatMessageContext,
  ) => void | Promise<void>;
  onDeliveryError?: (error: unknown, accountId: string) => void | Promise<void>;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
  callbackPort?: number;
}

export class WechatChannel {
  private readonly config: WechatConfig;
  private readonly onMessage: ChannelOptions["onMessage"];
  private readonly onDeliveryError: ChannelOptions["onDeliveryError"];
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly accounts = new Map<
    string,
    { account: ResolvedWechatAccount; bot: Bot }
  >();
  private readonly health = new Map<string, WechatTransportHealth>();
  private readonly tokens: TokenManager;
  private readonly api: WechatApiClient;
  private server: CallbackServerHandle | null = null;
  private abortController: AbortController | null = null;
  private readonly observedSenders = new Map<
    string,
    Map<string, ObservedSenderEntry>
  >();

  constructor(options: ChannelOptions) {
    this.config = options.config;
    this.onMessage = options.onMessage;
    this.onDeliveryError = options.onDeliveryError ?? (() => undefined);
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.tokens = new TokenManager({
      fetchFn: this.fetchFn,
      now: this.now,
      onHealthChange: (accountId, health) => {
        this.health.set(accountId, health);
      },
    });
    this.api = new WechatApiClient({
      tokens: this.tokens,
      fetchFn: this.fetchFn,
    });
  }

  /** Resolve and validate every configured direct account. */
  resolveAccounts(): ResolvedWechatAccount[] {
    const resolved: ResolvedWechatAccount[] = [];
    const sources: Array<[string, WechatAccountConfig]> = [];
    if (this.config.account) {
      sources.push(["default", this.config.account]);
    }
    for (const [id, account] of Object.entries(this.config.accounts ?? {})) {
      sources.push([id, account]);
    }
    for (const [id, accountConfig] of sources) {
      if (accountConfig.enabled === false) continue;
      resolved.push(resolveDirectAccount(id, accountConfig));
    }
    return resolved;
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    const resolved = this.resolveAccounts();
    if (resolved.length === 0) {
      console.warn("[wechat] No configured direct accounts found");
      return;
    }

    const port = this.config.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.server = await startCallbackServer({
      port,
      accounts: resolved,
      onMessage: (accountId, msg) => this.routeIncoming(accountId, msg),
      onDeliveryError: this.onDeliveryError,
      signal: this.abortController.signal,
    });

    for (const account of resolved) {
      this.accounts.set(account.id, {
        account,
        bot: new Bot({ onMessage: (msg) => this.onMessage(account.id, msg) }),
      });
      this.health.set(account.id, { state: "pending" });
    }

    // Startup transport probe: verify first-party credentials so account
    // health starts from an observation, not from configuration presence.
    await Promise.all(
      resolved.map(async (account) => {
        try {
          await this.tokens.getAccessToken(account);
        } catch (err) {
          const detail =
            err instanceof WechatError ? err.code : "token-probe-failed";
          console.error(
            `[wechat] Account "${account.id}" failed its startup token probe (${detail}) — marked unavailable`,
          );
        }
      }),
    );
  }

  async stop(): Promise<void> {
    for (const [, { bot }] of this.accounts) {
      bot.stop();
    }
    this.accounts.clear();
    this.tokens.dispose();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    const server = this.server;
    this.server = null;
    if (server) {
      await server.close().catch(() => undefined);
    }
  }

  async sendText(accountId: string, to: string, text: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) throw new Error(`Unknown account: ${accountId}`);
    const receipt = await this.api.sendText(entry.account, to, text);
    if (!receipt.ok) {
      throw new WechatError(
        "WECHAT_SEND_FAILED",
        "first-party send was rejected",
        {
          accountId,
          platformErrorCode: receipt.platformErrorCode,
          detail: receipt.redactedDetail,
        },
      );
    }
  }

  getAccountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  getAccountHealth(accountId: string): WechatTransportHealth | undefined {
    return this.health.get(accountId);
  }

  getResolvedAccount(accountId: string): ResolvedWechatAccount | undefined {
    return this.accounts.get(accountId)?.account;
  }

  /**
   * Targets derived exclusively from signature-verified inbound senders.
   * Registration here IS the account-bound observed evidence for a passive
   * transport with no roster API: an entry exists only because that platform
   * user verifiably interacted with that account.
   */
  listObservedTargets(): MessageConnectorTargetLite[] {
    const targets: MessageConnectorTargetLite[] = [];
    for (const [accountId, observed] of this.observedSenders) {
      for (const [platformUserId, entry] of observed) {
        targets.push({
          accountId,
          platformUserId,
          name: entry.name,
          kind: entry.kind,
          lastObservedAt: entry.lastObservedAt,
        });
      }
    }
    return targets.sort((a, b) => b.lastObservedAt - a.lastObservedAt);
  }

  /** Redacted, account-bound observed-evidence snapshot for diagnostics. */
  listAccountEvidence(): Array<{
    accountId: string;
    mode: string;
    platformIdentity: string;
    health: WechatTransportHealth | undefined;
    observedSenders: Array<{
      platformUserId: string;
      lastObservedAt: number;
      via: string;
    }>;
  }> {
    return this.getAccountIds().map((accountId) => {
      const account = this.getResolvedAccount(accountId);
      return {
        accountId,
        mode: account?.mode ?? "unknown",
        platformIdentity: account?.platformIdentity ?? "",
        health: this.health.get(accountId),
        observedSenders: Array.from(
          this.observedSenders.get(accountId)?.entries() ?? [],
        ).map(([platformUserId, entry]) => ({
          platformUserId,
          lastObservedAt: entry.lastObservedAt,
          via: entry.via,
        })),
      };
    });
  }

  private observeSender(accountId: string, msg: WechatMessageContext): void {
    let accountMap = this.observedSenders.get(accountId);
    if (!accountMap) {
      accountMap = new Map();
      this.observedSenders.set(accountId, accountMap);
    }
    const existing = accountMap.get(msg.sender);
    const via =
      msg.type === "event"
        ? `event:${msg.event ?? "unknown"}`
        : `message:${msg.type}`;
    accountMap.set(msg.sender, {
      name: existing?.name,
      kind: msg.group ? "group" : "user",
      lastObservedAt: this.now(),
      via,
    });
  }

  private async routeIncoming(
    accountId: string,
    msg: WechatMessageContext,
  ): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) {
      throw new Error(
        `[wechat] Cannot deliver callback for unknown account "${accountId}"`,
      );
    }
    // A signature-verified callback is a transport observation.
    this.health.set(accountId, {
      state: "connected",
      lastSuccessAt: this.now(),
      observedVia: "verified-callback",
    });
    this.observeSender(accountId, msg);
    await entry.bot.handleIncoming(msg);
  }
}

/** Validate one direct account config into its resolved runtime shape. */
export function resolveDirectAccount(
  id: string,
  input: WechatAccountConfig,
): ResolvedWechatAccount {
  // Guard the raw, possibly-unvalidated discriminator first: legacy proxy and
  // personal-WeChat shapes must fail with their dedicated codes, not slip
  // through union narrowing.
  const rawMode = (input as { mode?: unknown }).mode;
  if (rawMode === "personal") {
    throw new WechatError(
      "WECHAT_PERSONAL_MODE_UNSUPPORTED",
      "personal WeChat has no first-party API and is unsupported",
      { accountId: id },
    );
  }
  if (rawMode === "proxy") {
    throw new WechatError(
      "WECHAT_PROXY_CONFIG_UNSUPPORTED",
      "proxy-based WeChat configuration was removed",
      { accountId: id },
    );
  }
  const config = input as WechatAccountConfig;
  if (config.mode === "official-account") {
    if (
      !config.appId?.trim() ||
      !config.appSecret?.trim() ||
      !config.token?.trim()
    ) {
      throw new WechatError(
        "WECHAT_CONFIG_INVALID",
        "official-account requires appId, appSecret, and token",
        { accountId: id },
      );
    }
    const securityMode = config.messageSecurityMode ?? "plaintext";
    if (securityMode === "encrypted" && !config.encodingAESKey?.trim()) {
      throw new WechatError(
        "WECHAT_CONFIG_INVALID",
        "encrypted security mode requires encodingAESKey",
        { accountId: id },
      );
    }
    return {
      id,
      mode: "official-account",
      platformAccountId: config.appId.trim(),
      platformIdentity: config.appId.trim(),
      secret: config.appSecret.trim(),
      securityMode,
      tokenSecret: config.token.trim(),
      encodingAESKey: config.encodingAESKey?.trim(),
      label: config.name ?? `Official Account ${config.appId.trim()}`,
    };
  }
  if (config.mode === "wecom") {
    if (
      !config.corpId?.trim() ||
      !config.agentId ||
      !config.corpSecret?.trim() ||
      !config.token?.trim() ||
      !config.encodingAESKey?.trim()
    ) {
      throw new WechatError(
        "WECHAT_CONFIG_INVALID",
        "wecom requires corpId, agentId, corpSecret, token, and encodingAESKey",
        { accountId: id },
      );
    }
    return {
      id,
      mode: "wecom",
      platformAccountId: `${config.corpId.trim()}_${config.agentId}`,
      platformIdentity: config.corpId.trim(),
      wecomAgentId: config.agentId,
      secret: config.corpSecret.trim(),
      securityMode: "encrypted",
      tokenSecret: config.token.trim(),
      encodingAESKey: config.encodingAESKey.trim(),
      label: config.name ?? `WeCom ${config.corpId.trim()}/${config.agentId}`,
    };
  }
  throw new WechatError(
    "WECHAT_CONFIG_INVALID",
    "account configuration has no supported mode",
    { accountId: id, mode: (config as { mode?: string }).mode },
  );
}
