/** Defines deterministic seed, fault, observation, and readback contracts for the WeChat proxy simulator. */

export interface WechatProxyAccountSeed {
  accountId: string;
  apiKey: string;
  deviceType?: "ipad" | "mac";
  loginState?: "waiting" | "need_verify" | "logged_in";
  wcId?: string;
  nickName?: string;
  friends?: Array<{ wxid: string; name: string }>;
  chatrooms?: Array<{ wxid: string; name: string }>;
}

export interface WechatProxySeed {
  accounts: WechatProxyAccountSeed[];
}

export interface WechatProxyFault {
  status?: number;
  body?: unknown;
  rawBody?: string;
  retryAfter?: string;
  delayMs?: number;
}

export interface WechatProxyRequestObservation {
  sequence: number;
  accountId: string | null;
  deviceType: string | null;
  method: string;
  path: string;
  body: unknown;
  authenticated: boolean;
}

export interface WechatProxyOutboundMessage {
  sequence: number;
  accountId: string;
  kind: "text" | "image";
  to: string;
  text?: string;
  imagePath?: string;
}

export interface WechatProxySnapshot {
  generation: number;
  requests: WechatProxyRequestObservation[];
  outboundMessages: WechatProxyOutboundMessage[];
  webhooks: Record<string, string>;
}

export interface WechatWebhookDeliveryOptions {
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
