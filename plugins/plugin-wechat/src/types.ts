/**
 * Shared contracts for the direct first-party WeChat connector: a discriminated
 * account configuration (WeChat Official Account or WeCom self-built app —
 * personal WeChat has no legitimate first-party API and is rejected), observed
 * inbound message context, outbound send receipts, and the observational
 * transport-health state that governs every capability claim. Legacy
 * proxy-based configuration shapes are deliberately absent.
 */

import { ElizaError } from "@elizaos/core";

/** Discriminator for the two supported first-party WeChat platforms. */
export type WechatMode = "official-account" | "wecom";

/** Explicitly unsupported modes with dedicated failure codes. */
export type WechatUnsupportedMode = "personal" | "proxy" | "wecom-third-party";

/**
 * Cryptography mode for inbound platform callbacks. WeCom is always encrypted;
 * Official Accounts pick per their MP console configuration.
 */
export type WechatMessageSecurityMode = "plaintext" | "encrypted";

export interface WechatAccountBase {
  enabled?: boolean;
  name?: string;
  /**
   * Inbound receiver identity for callback binding. WeCom: the corpId (same
   * as corpId). Official Account: the account's WeChat original ID (gh_...)
   * from the MP console — NOT the appId, which is only the token API identity.
   * When omitted for an official-account, receiver binding is skipped rather
   * than mis-verified against the appId.
   */
  callbackId?: string;
  /**
   * Public HTTPS callback base URL (e.g. `https://bot.example.com`) under which
   * this plugin's callback routes are reachable. Display/diagnostics only —
   * the platform is configured with it out of band; the plugin never registers
   * it anywhere.
   */
  callbackBaseUrl?: string;
  /** Distinguishes callback URL verification from message delivery in logs. */
  callbackPathPrefix?: string;
}

export interface WechatOfficialAccountConfig extends WechatAccountBase {
  mode: "official-account";
  appId: string;
  appSecret: string;
  /** Callback signature verification token configured in the MP console. */
  token: string;
  /** Required when the MP console uses the compatible/safe security mode. */
  encodingAESKey?: string;
  /** Defaults to "plaintext". "encrypted" requires `encodingAESKey`. */
  messageSecurityMode?: WechatMessageSecurityMode;
}

export interface WechatWecomConfig extends WechatAccountBase {
  mode: "wecom";
  corpId: string;
  agentId: number;
  corpSecret: string;
  /** WeCom callbacks are always encrypted; both callback secrets are required. */
  token: string;
  encodingAESKey: string;
}

export type WechatAccountConfig =
  | WechatOfficialAccountConfig
  | WechatWecomConfig;

export interface WechatConfig {
  enabled?: boolean;
  /** Single-account shorthand; equivalent to `accounts: { default: ... }`. */
  account?: WechatAccountConfig;
  accounts?: Record<string, WechatAccountConfig>;
  /** Public port for the shared callback server (default 18790). */
  callbackPort?: number;
  features?: {
    images?: boolean;
    groups?: boolean;
  };
}

/** A fully validated direct-mode account, keyed by its connector account id. */
export interface ResolvedWechatAccount {
  id: string;
  mode: WechatMode;
  /** official-account: appId; wecom: `corpId_agentId`. */
  platformAccountId: string;
  /** official-account: appId; wecom: corpId. */
  platformIdentity: string;
  /** official-account: agentId absent; wecom: the app's agentId. */
  wecomAgentId?: number;
  /** App secret (official-account) or corp secret (wecom) for token fetch. */
  secret: string;
  securityMode: WechatMessageSecurityMode;
  tokenSecret: string;
  encodingAESKey?: string;
  /**
   * Expected inbound ToUserName/AES receiver identity when configured; for
   * wecom this is the corpId, for official-account the gh_ original ID.
   * Undefined means receiver binding is skipped (no mis-verification).
   */
  callbackIdentity?: string;
  label: string;
}

export type WechatMessageType =
  | "text"
  | "image"
  | "video"
  | "file"
  | "voice"
  | "event"
  | "unknown";

/**
 * A platform callback that passed signature verification and was normalized
 * into the transport-independent inbound shape the dedup gate and runtime
 * bridge consume. `platform` carries identity fields that differ per mode.
 */
export interface WechatMessageContext {
  id: string;
  type: WechatMessageType;
  sender: string;
  recipient: string;
  content: string;
  /** Epoch milliseconds, from the signed callback payload. */
  timestamp: number;
  threadId?: string;
  group?: {
    subject: string;
  };
  imageUrl?: string;
  /** WeCom app message target agent id, when the payload carries AgentID. */
  agentId?: number;
  /** Subscribe/unsubscribe/notification event kind for `type: "event"`. */
  event?: string;
  platform: {
    mode: WechatMode;
    accountId: string;
  };
  /** Redacted diagnostic provenance; never carries secrets or full raw XML. */
  raw: unknown;
}

/**
 * Observational transport health for one account. Presence of configuration
 * alone can only produce "pending"; "connected" requires a successful
 * first-party API or verified-callback observation.
 */
export type WechatTransportState =
  | "pending"
  | "connected"
  | "degraded"
  | "unavailable";

export interface WechatTransportHealth {
  state: WechatTransportState;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  /** Redacted platform error code/category; never a secret-bearing message. */
  lastFailureDetail?: string;
  /** Epoch ms after which `state: "connected"` was observed. */
  observedVia?: "token-probe" | "verified-callback" | "send-receipt";
}

/** Redacted first-party API receipt for an outbound send. */
export interface WechatSendReceipt {
  ok: boolean;
  platformErrorCode?: number;
  redactedDetail?: string;
}

/**
 * Errors thrown by this plugin carry a stable machine-readable `code` so route
 * and connector boundaries can translate failures without string matching.
 * `WechatError` extends the core `ElizaError` per the repository error policy:
 * a domain failure with an actionable code, structured context, and a preserved
 * `cause` chain when wrapping.
 */
export type WechatErrorCode =
  | "WECHAT_CONFIG_INVALID"
  | "WECHAT_PERSONAL_MODE_UNSUPPORTED"
  | "WECHAT_PROXY_CONFIG_UNSUPPORTED"
  | "WECHAT_WECOM_THIRD_PARTY_UNSUPPORTED"
  | "WECHAT_CALLBACK_SIGNATURE_INVALID"
  | "WECHAT_CALLBACK_DECRYPT_FAILED"
  | "WECHAT_CALLBACK_MALFORMED"
  | "WECHAT_TOKEN_UNAVAILABLE"
  | "WECHAT_SEND_FAILED"
  | "WECHAT_ACCOUNT_UNAVAILABLE";

export class WechatError extends ElizaError {
  readonly code: WechatErrorCode;
  override readonly context: Record<string, unknown>;

  constructor(
    code: WechatErrorCode,
    message: string,
    context?: Record<string, unknown>,
    options?: { cause?: unknown; severity?: "ephemeral" | "fatal" },
  ) {
    super(message, {
      code,
      context: context ?? {},
      cause: options?.cause,
      severity: options?.severity,
    });
    this.code = code;
    this.context = context ?? {};
  }
}
