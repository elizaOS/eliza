/**
 * Runtime-owned lifecycle orchestrator for direct-mode WeChat accounts:
 * resolves and validates the direct configuration, starts one public callback
 * server shared by all accounts, verifies transport health via a token probe
 * at startup, and owns outbound sends through the first-party API client via
 * the chunking ReplyDispatcher. The proxy login/registration flow that
 * previously lived here is deleted. Health is split per direction: inbound
 * (verified-callback observations) and outbound (token-probe/send receipts)
 * are tracked separately, and an account whose outbound transport failed is
 * never reported healthy from inbound evidence alone.
 */
import { logger } from "@elizaos/core";
import { WechatApiClient } from "./api-client";
import { Bot } from "./bot";
import {
  type CallbackServerHandle,
  startCallbackServer,
} from "./callback-server";
import { ReplyDispatcher } from "./reply-dispatcher";
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
const WECHAT_AES_KEY_BASE64_LENGTH = 43;

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

/** Minimum time after a failed probe before a send re-attempts token recovery. */
const UNAVAILABLE_RECOVERY_BACKOFF_MS = 30_000;

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
    { account: ResolvedWechatAccount; bot: Bot; dispatcher: ReplyDispatcher }
  >();
  /** Outbound-transport health (token probes, send receipts). */
  private readonly outboundHealth = new Map<string, WechatTransportHealth>();
  /** Inbound-transport health (verified-callback observations). */
  private readonly inboundHealth = new Map<string, WechatTransportHealth>();
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
        this.outboundHealth.set(accountId, health);
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
      const trimmed = id.trim().toLowerCase();
      if (!trimmed) {
        // A whitespace-only key would normalize to an unreachable callback
        // route; reject it at configuration time instead.
        throw new WechatError(
          "WECHAT_CONFIG_INVALID",
          "wechat account id must contain non-whitespace characters",
          { accountId: id },
        );
      }
      sources.push([trimmed, account]);
    }
    for (const [id, accountConfig] of sources) {
      if (accountConfig.enabled === false) continue;
      if (resolved.some((existing) => existing.id === id)) {
        throw new WechatError(
          "WECHAT_CONFIG_INVALID",
          "duplicate wechat account id (the single-account block collides with accounts map)",
          { accountId: id },
        );
      }
      resolved.push(resolveDirectAccount(id, accountConfig));
    }
    return resolved;
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    const resolved = this.resolveAccounts();
    if (resolved.length === 0) {
      logger.warn("[wechat] No configured direct accounts found");
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
        dispatcher: new ReplyDispatcher({
          client: {
            sendText: async (to, text) => {
              const receipt = await this.api.sendText(account, to, text);
              if (!receipt.ok) {
                // A platform-rejected send is a real failure: mark outbound
                // health and surface a typed error instead of discarding the
                // receipt and reporting success.
                this.outboundHealth.set(account.id, {
                  state: "degraded",
                  lastFailureAt: this.now(),
                  lastFailureDetail:
                    receipt.platformErrorCode !== undefined
                      ? `send-errcode-${receipt.platformErrorCode}`
                      : "send-rejected",
                });
                throw new WechatError(
                  "WECHAT_SEND_FAILED",
                  "first-party platform rejected the send",
                  {
                    accountId: account.id,
                    platformErrorCode: receipt.platformErrorCode,
                    redactedDetail: receipt.redactedDetail,
                  },
                );
              }
              this.outboundHealth.set(account.id, {
                state: "connected",
                lastSuccessAt: this.now(),
                observedVia: "send-receipt",
              });
            },
          },
        }),
      });
      this.outboundHealth.set(account.id, { state: "pending" });
      this.inboundHealth.set(account.id, { state: "pending" });
    }

    // Startup transport probe: verify first-party credentials so outbound
    // health starts from an observation, not from configuration presence. A
    // failed account keeps its callback route (recovery is possible) but is
    // reported unavailable until a probe succeeds.
    await Promise.all(
      resolved.map(async (account) => {
        try {
          await this.tokens.getAccessToken(account);
        } catch (err) {
          // error-policy:J4 a failed startup probe degrades the account to a
          // visibly distinct outbound-unavailable state; startup continues.
          const detail =
            err instanceof WechatError ? err.code : "token-probe-failed";
          logger.error(
            `[wechat] Account "${account.id}" failed its startup token probe (${detail}) — outbound marked unavailable`,
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
      try {
        await server.close();
      } catch (error) {
        // error-policy:J6 teardown-only failure is logged, never propagated
        // over an already-aborting dispose path.
        logger.warn(
          `[wechat] Callback server close failed during stop: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async sendText(accountId: string, to: string, text: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) {
      throw new WechatError(
        "WECHAT_ACCOUNT_UNAVAILABLE",
        `Unknown account: ${accountId}`,
        { accountId },
      );
    }
    // Fail closed on an outbound-unavailable account: an API/login failure
    // must surface as a typed error, never a hopeful network attempt. A probe
    // may lift the state after the recovery backoff so a transient startup
    // failure (DNS blip, timeout) cannot strand outbound until restart.
    const outbound = this.outboundHealth.get(accountId);
    if (outbound?.state === "unavailable") {
      await this.attemptRecovery(accountId, entry.account);
      const recovered = this.outboundHealth.get(accountId);
      if (recovered?.state === "unavailable") {
        throw new WechatError(
          "WECHAT_ACCOUNT_UNAVAILABLE",
          "wechat account outbound transport is unavailable",
          {
            accountId,
            lastFailureDetail: recovered.lastFailureDetail,
          },
        );
      }
    }
    // The dispatcher chunks the text and sends each chunk through the
    // first-party API client.
    await entry.dispatcher.sendText(to, text);
  }

  getAccountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  /**
   * Combined observational health. An account reads "connected" only when
   * its outbound transport was observed healthy (token probe/send receipt);
   * inbound-only evidence can lift a pending account no higher than
   * "degraded" so inbound activity never masks a dead outbound path.
   */
  getAccountHealth(accountId: string): WechatTransportHealth | undefined {
    const outbound = this.outboundHealth.get(accountId);
    const inbound = this.inboundHealth.get(accountId);
    if (!outbound) return undefined;
    if (outbound.state === "connected") {
      return inbound?.state === "connected"
        ? outbound
        : { ...outbound, observedVia: "token-probe" };
    }
    if (outbound.state === "unavailable" || outbound.state === "degraded") {
      return outbound;
    }
    // pending outbound: inbound evidence alone cannot claim connected.
    if (inbound?.state === "connected") {
      return { ...inbound, state: "degraded" };
    }
    return outbound;
  }

  /**
   * Rate-limited recovery probe for an outbound-unavailable account. A send
   * arriving after the backoff window re-runs the token probe; success flips
   * health to connected (the send then proceeds through the normal path) and
   * failure re-marks unavailable with a fresh timestamp, restarting the
   * backoff. Probes inside the window are skipped so a dead platform cannot
   * turn every send into a synchronous network call.
   */
  private async attemptRecovery(
    accountId: string,
    account: ResolvedWechatAccount,
  ): Promise<void> {
    const outbound = this.outboundHealth.get(accountId);
    if (outbound?.state !== "unavailable") return;
    const elapsed = this.now() - (outbound.lastFailureAt ?? 0);
    if (elapsed < UNAVAILABLE_RECOVERY_BACKOFF_MS) return;
    try {
      await this.tokens.getAccessToken(account);
      // getAccessToken reports health through onHealthChange on both
      // outcomes; a success here flips outboundHealth to connected.
    } catch {
      // error-policy:J4 the failed recovery probe leaves the account in its
      // visibly distinct unavailable state; sendText translates to the typed
      // WECHAT_ACCOUNT_UNAVAILABLE error at its boundary.
    }
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
        health: this.getAccountHealth(accountId),
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
      throw new WechatError(
        "WECHAT_ACCOUNT_UNAVAILABLE",
        `Cannot deliver callback for unknown account "${accountId}"`,
        { accountId },
      );
    }
    // A signature-verified callback is an INBOUND observation only.
    this.inboundHealth.set(accountId, {
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
  // Guard the raw, possibly-unvalidated discriminator first: legacy proxy,
  // personal-WeChat, and wecom third-party shapes fail with dedicated codes.
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
  if (rawMode === "wecom-third-party") {
    throw new WechatError(
      "WECHAT_WECOM_THIRD_PARTY_UNSUPPORTED",
      "WeCom third-party (suite) apps are not supported; configure a self-built app",
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
    if (securityMode !== "plaintext" && securityMode !== "encrypted") {
      throw new WechatError(
        "WECHAT_CONFIG_INVALID",
        'messageSecurityMode must be "plaintext" or "encrypted"',
        { accountId: id, messageSecurityMode: securityMode },
      );
    }
    if (securityMode === "encrypted") {
      assertValidAesKey(config.encodingAESKey, id);
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
      // The inbound receiver id is the gh_ original ID, not the appId.
      callbackIdentity: config.callbackId?.trim() || undefined,
      label: config.name ?? `Official Account ${config.appId.trim()}`,
    };
  }
  if (config.mode === "wecom") {
    if (
      !config.corpId?.trim() ||
      !config.corpSecret?.trim() ||
      !config.token?.trim()
    ) {
      throw new WechatError(
        "WECHAT_CONFIG_INVALID",
        "wecom requires corpId, corpSecret, and token",
        { accountId: id },
      );
    }
    if (!Number.isSafeInteger(config.agentId) || (config.agentId ?? 0) <= 0) {
      throw new WechatError(
        "WECHAT_CONFIG_INVALID",
        "wecom agentId must be a positive integer",
        { accountId: id, agentId: config.agentId },
      );
    }
    assertValidAesKey(config.encodingAESKey, id);
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
      // WeCom callbacks always address the corp; callbackId may override.
      callbackIdentity: config.callbackId?.trim() || config.corpId.trim(),
      label: config.name ?? `WeCom ${config.corpId.trim()}/${config.agentId}`,
    };
  }
  throw new WechatError(
    "WECHAT_CONFIG_INVALID",
    "account configuration has no supported mode",
    {
      accountId: id,
      mode: rawMode,
    },
  );
}

function assertValidAesKey(value: string | undefined, accountId: string): void {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length !== WECHAT_AES_KEY_BASE64_LENGTH) {
    throw new WechatError(
      "WECHAT_CONFIG_INVALID",
      "encodingAESKey must be exactly 43 base64 characters",
      { accountId, length: trimmed.length },
    );
  }
  const decoded = Buffer.from(`${trimmed}=`, "base64");
  if (decoded.length !== 32) {
    throw new WechatError(
      "WECHAT_CONFIG_INVALID",
      "encodingAESKey must decode to 32 bytes",
      { accountId, decodedLength: decoded.length },
    );
  }
}
