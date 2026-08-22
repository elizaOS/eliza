/**
 * HTTPS client for the third-party WeChat proxy service (not the official WeChat
 * API): login/status polling and outbound text/image sends over the proxy's API
 * key. Maps the proxy's numeric result codes — success `1000`, login-needed
 * `1001` (surfaced as `LoginExpiredError`) — into typed results the channel acts on.
 */
import type {
  AccountStatus,
  ProxyApiResponse,
  ResolvedWechatAccount,
} from "./types";

const SUCCESS = 1000;
const LOGIN_NEEDED = 1001;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_RETRY_BASE_DELAY_MS = 8_000;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export interface ProxyClientOptions {
  requestTimeoutMs?: number;
  retryBaseDelayMs?: number;
  signal?: AbortSignal;
}

export class ProxyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly accountId: string;
  private readonly deviceType: string;
  private readonly requestTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly signal?: AbortSignal;

  constructor(
    account: ResolvedWechatAccount,
    options: ProxyClientOptions = {},
  ) {
    this.apiKey = account.apiKey;
    this.baseUrl = normalizeProxyUrl(account.proxyUrl);
    this.accountId = account.id;
    this.deviceType = account.deviceType ?? "ipad";
    this.requestTimeoutMs = requireBoundedPositiveInteger(
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
      MAX_REQUEST_TIMEOUT_MS,
    );
    this.retryBaseDelayMs = requireBoundedPositiveInteger(
      options.retryBaseDelayMs ?? 1000,
      "retryBaseDelayMs",
      MAX_RETRY_BASE_DELAY_MS,
    );
    this.signal = options.signal;
  }

  private async request<T>(
    path: string,
    body?: Record<string, unknown>,
    retryAmbiguousFailures = true,
  ): Promise<ProxyApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
      "X-Account-ID": this.accountId,
      "X-Device-Type": this.deviceType,
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (this.signal?.aborted) {
          throw this.signal.reason ?? new Error("WeChat proxy request aborted");
        }
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        const signal = this.signal
          ? AbortSignal.any([this.signal, timeoutSignal])
          : timeoutSignal;
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal,
          redirect: "error",
        });

        if (res.status === 429) {
          const delay = retryDelayMs(
            res.headers.get("Retry-After"),
            attempt,
            this.retryBaseDelayMs,
          );
          // Consume the response body to release the connection
          await discardBoundedBody(res);
          await sleep(delay, this.signal);
          continue;
        }

        if (!res.ok) {
          // Consume the body to release the connection, but never trust or
          // surface an untrusted error envelope. HTTP status is authoritative:
          // a forged `{ code: 1000 }` on an error status cannot become success.
          await discardBoundedBody(res);
          throw new ProxyHttpStatusError(res.status);
        }

        if (!isJsonMediaType(res.headers.get("content-type"))) {
          await discardBoundedBody(res);
          throw new Error("WeChat proxy response must use application/json");
        }
        let json: unknown;
        const responseBody = await readBoundedBody(res);
        try {
          json = JSON.parse(responseBody);
        } catch {
          // error-policy:J1 Provider-controlled parser details are redacted at the client boundary.
          throw new ProxyResponseError();
        }
        return parseEnvelope(json) as ProxyApiResponse<T>;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (this.signal?.aborted) {
          throw this.signal.reason ?? lastError;
        }
        if (err instanceof ProxyHttpStatusError && !err.retryable) {
          throw err;
        }
        if (!retryAmbiguousFailures) {
          throw lastError;
        }
        if (attempt === 2) {
          throw lastError;
        }
        const delay = Math.min(this.retryBaseDelayMs * 2 ** attempt, 8000);
        await sleep(delay, this.signal);
      }
    }

    throw lastError ?? new Error(`Request failed after 3 attempts: ${path}`);
  }

  async getStatus(): Promise<AccountStatus> {
    const res = await this.request<AccountStatus>("/api/status");
    if (res.code === LOGIN_NEEDED) {
      return {
        valid: true,
        loginState: "waiting",
      };
    }
    if (res.code !== SUCCESS && res.code !== 1002) {
      throw new ProxyProviderError("getStatus", res.code);
    }
    return parseAccountStatus(requireData(res));
  }

  async getQRCode(): Promise<string> {
    const res = await this.request<{ qrCodeUrl: string }>("/api/qrcode");
    if (res.code !== SUCCESS) {
      throw new ProxyProviderError("getQRCode", res.code);
    }
    return parseQrCode(requireData(res));
  }

  async checkLogin(): Promise<{
    status: "waiting" | "need_verify" | "logged_in";
    verifyUrl?: string;
    wcId?: string;
    nickName?: string;
  }> {
    const res = await this.request<{
      status: "waiting" | "need_verify" | "logged_in";
      verifyUrl?: string;
      wcId?: string;
      nickName?: string;
    }>("/api/check-login");
    if (res.code !== SUCCESS && res.code !== 1002) {
      throw new ProxyProviderError("checkLogin", res.code);
    }
    return parseLoginStatus(requireData(res));
  }

  async sendText(to: string, text: string): Promise<void> {
    const res = await this.request("/api/send-text", { to, text }, false);
    if (res.code === LOGIN_NEEDED) {
      throw new LoginExpiredError();
    }
    if (res.code !== SUCCESS && res.code !== 1002) {
      throw new ProxyProviderError("sendText", res.code);
    }
    parseAcceptedMutation(requireData(res), "sendText");
  }

  async sendImage(to: string, imagePath: string, text?: string): Promise<void> {
    const res = await this.request(
      "/api/send-image",
      { to, imagePath, text },
      false,
    );
    if (res.code === LOGIN_NEEDED) {
      throw new LoginExpiredError();
    }
    if (res.code !== SUCCESS && res.code !== 1002) {
      throw new ProxyProviderError("sendImage", res.code);
    }
    parseAcceptedMutation(requireData(res), "sendImage");
  }

  async getContacts(): Promise<{
    friends: Array<{ wxid: string; name: string }>;
    chatrooms: Array<{ wxid: string; name: string }>;
  }> {
    const res = await this.request<{
      friends: Array<{ wxid: string; name: string }>;
      chatrooms: Array<{ wxid: string; name: string }>;
    }>("/api/contacts");
    if (res.code !== SUCCESS) {
      throw new ProxyProviderError("getContacts", res.code);
    }
    return parseContacts(requireData(res));
  }

  async registerWebhook(url: string): Promise<void> {
    const res = await this.request("/api/webhook/register", {
      webhookUrl: url,
    });
    if (res.code !== SUCCESS && res.code !== 1002) {
      throw new ProxyProviderError("registerWebhook", res.code);
    }
    parseRegisteredWebhook(requireData(res));
  }

  get needsLogin(): boolean {
    return false; // Caller checks via getStatus()
  }
}

export class LoginExpiredError extends Error {
  constructor() {
    super("WeChat login expired — re-login required");
    this.name = "LoginExpiredError";
  }
}

export class ProxyProviderError extends Error {
  constructor(
    readonly operation: string,
    readonly providerCode: number,
  ) {
    super(`WeChat proxy ${operation} failed with code ${providerCode}`);
    this.name = "ProxyProviderError";
  }
}

class ProxyResponseError extends Error {
  constructor() {
    super("WeChat proxy returned an invalid response");
    this.name = "ProxyResponseError";
  }
}

class ProxyHttpStatusError extends Error {
  readonly retryable: boolean;

  constructor(readonly status: number) {
    super(`WeChat proxy request failed with HTTP ${status}`);
    this.name = "ProxyHttpStatusError";
    this.retryable = status === 408 || status >= 500;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("WeChat proxy request aborted"),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("WeChat proxy request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const MAX_BACKOFF_MS = 8000;
// JavaScript timers overflow above a signed 32-bit delay and may fire almost
// immediately, which would defeat the rate-limit backoff this parser protects.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const HTTP_DATE_PATTERN =
  /^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/;

/**
 * RFC 7231 §7.1.3 allows Retry-After to be either delay-seconds ("120") or an
 * HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT"). `Number.parseInt` on the date
 * form silently returns NaN, which made `setTimeout` fire almost immediately
 * instead of honoring the server's backoff. Falls back to the existing
 * exponential backoff when the header is absent or neither form parses.
 */
export function retryDelayMs(
  retryAfterHeader: string | null,
  attempt: number,
  baseDelayMs = 1000,
): number {
  const fallback = Math.min(baseDelayMs * 2 ** attempt, MAX_BACKOFF_MS);
  if (!retryAfterHeader) return fallback;

  const value = retryAfterHeader.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return MAX_TIMER_DELAY_MS;
    return Math.min(seconds * 1000, MAX_TIMER_DELAY_MS);
  }

  if (HTTP_DATE_PATTERN.test(value)) {
    const dateMs = Date.parse(value);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), MAX_TIMER_DELAY_MS);
    }
  }

  return fallback;
}

function normalizeProxyUrl(proxyUrl: string): string {
  const parsed = new URL(proxyUrl);
  const isLoopbackHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !isLoopbackHttp) {
    throw new Error(
      "[wechat] proxyUrl must use https:// (loopback http:// is allowed for local protocol simulators)",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("[wechat] proxyUrl must not include credentials");
  }
  if (parsed.search) {
    throw new Error("[wechat] proxyUrl must not include query parameters");
  }
  if (parsed.hash) {
    throw new Error("[wechat] proxyUrl must not include a fragment");
  }
  return parsed.toString().replace(/\/$/, "");
}

function requireBoundedPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `[wechat] ${name} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function requireData<T>(response: ProxyApiResponse<T>): T {
  if (response.data === undefined) {
    throw new ProxyResponseError();
  }
  return response.data;
}

function parseEnvelope(value: unknown): ProxyApiResponse<unknown> {
  const record = strictRecord(value, ["code"], ["message", "data"]);
  if (!Number.isSafeInteger(record.code)) throw new ProxyResponseError();
  if (
    record.message !== undefined &&
    (typeof record.message !== "string" || record.message.length > 4096)
  ) {
    throw new ProxyResponseError();
  }
  return {
    code: record.code as number,
    ...(record.message === undefined
      ? {}
      : { message: record.message as string }),
    ...(record.data === undefined ? {} : { data: record.data }),
  };
}

function parseAccountStatus(value: unknown): AccountStatus {
  const record = strictRecord(
    value,
    ["valid", "loginState"],
    ["wcId", "nickName", "tier", "quota"],
  );
  if (typeof record.valid !== "boolean") throw new ProxyResponseError();
  if (!isLoginStatus(record.loginState)) throw new ProxyResponseError();
  optionalStrings(record, ["wcId", "nickName", "tier"]);
  if (
    record.quota !== undefined &&
    (typeof record.quota !== "number" || !Number.isFinite(record.quota))
  ) {
    throw new ProxyResponseError();
  }
  return record as unknown as AccountStatus;
}

function parseQrCode(value: unknown): string {
  const record = strictRecord(value, ["qrCodeUrl"], []);
  return requiredString(record.qrCodeUrl);
}

function parseLoginStatus(value: unknown): {
  status: "waiting" | "need_verify" | "logged_in";
  verifyUrl?: string;
  wcId?: string;
  nickName?: string;
} {
  const record = strictRecord(
    value,
    ["status"],
    ["verifyUrl", "wcId", "nickName"],
  );
  if (!isLoginStatus(record.status)) throw new ProxyResponseError();
  optionalStrings(record, ["verifyUrl", "wcId", "nickName"]);
  return record as ReturnType<typeof parseLoginStatus>;
}

function parseContacts(value: unknown): {
  friends: Array<{ wxid: string; name: string }>;
  chatrooms: Array<{ wxid: string; name: string }>;
} {
  const record = strictRecord(value, ["friends", "chatrooms"], []);
  return {
    friends: parseContactList(record.friends),
    chatrooms: parseContactList(record.chatrooms),
  };
}

function parseContactList(
  value: unknown,
): Array<{ wxid: string; name: string }> {
  if (!Array.isArray(value) || value.length > 100_000)
    throw new ProxyResponseError();
  return value.map((item) => {
    const record = strictRecord(item, ["wxid", "name"], []);
    return {
      wxid: requiredString(record.wxid),
      name: requiredString(record.name),
    };
  });
}

function parseAcceptedMutation(value: unknown, operation: string): void {
  const record = strictRecord(value, ["accepted", "operation"], []);
  if (record.accepted !== true || record.operation !== operation)
    throw new ProxyResponseError();
}

function parseRegisteredWebhook(value: unknown): void {
  const record = strictRecord(value, ["registered"], []);
  if (record.registered !== true) throw new ProxyResponseError();
}

function strictRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProxyResponseError();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new ProxyResponseError();
  }
  return record;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new ProxyResponseError();
  return value;
}

function optionalStrings(
  record: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (record[key] !== undefined) requiredString(record[key]);
  }
}

function isLoginStatus(
  value: unknown,
): value is "waiting" | "need_verify" | "logged_in" {
  return (
    value === "waiting" || value === "need_verify" || value === "logged_in"
  );
}

function isJsonMediaType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BODY_BYTES
  ) {
    await response.body?.cancel("response body exceeds client limit");
    throw new Error("WeChat proxy response body exceeds 1048576 bytes");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel("response body exceeds client limit");
      throw new Error("WeChat proxy response body exceeds 1048576 bytes");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function discardBoundedBody(response: Response): Promise<void> {
  try {
    await readBoundedBody(response);
  } catch {
    // error-policy:J6 draining is connection-reuse cleanup; status remains authoritative.
  }
}
