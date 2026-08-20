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

export class ProxyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly accountId: string;
  private readonly deviceType: string;

  constructor(account: ResolvedWechatAccount) {
    this.apiKey = account.apiKey;
    this.baseUrl = normalizeProxyUrl(account.proxyUrl);
    this.accountId = account.id;
    this.deviceType = account.deviceType ?? "ipad";
  }

  private async request<T>(
    path: string,
    body?: Record<string, unknown>,
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
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.status === 429) {
          const delay = retryDelayMs(res.headers.get("Retry-After"), attempt);
          // Consume the response body to release the connection
          await res.text().catch(() => {});
          await sleep(delay);
          continue;
        }

        const json = (await res.json()) as ProxyApiResponse<T>;
        return json;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        await sleep(delay);
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
      throw new Error(`getStatus failed: ${res.message ?? res.code}`);
    }
    return requireData(res, "getStatus");
  }

  async getQRCode(): Promise<string> {
    const res = await this.request<{ qrCodeUrl: string }>("/api/qrcode");
    if (res.code !== SUCCESS) {
      throw new Error(`getQRCode failed: ${res.message ?? res.code}`);
    }
    return requireData(res, "getQRCode").qrCodeUrl;
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
      throw new Error(`checkLogin failed: ${res.message ?? res.code}`);
    }
    return requireData(res, "checkLogin");
  }

  async sendText(to: string, text: string): Promise<void> {
    const res = await this.request("/api/send-text", { to, text });
    if (res.code === LOGIN_NEEDED) {
      throw new LoginExpiredError();
    }
    if (res.code !== SUCCESS && res.code !== 1002) {
      throw new Error(`sendText failed: ${res.message ?? res.code}`);
    }
  }

  async sendImage(to: string, imagePath: string, text?: string): Promise<void> {
    const res = await this.request("/api/send-image", {
      to,
      imagePath,
      text,
    });
    if (res.code === LOGIN_NEEDED) {
      throw new LoginExpiredError();
    }
    if (res.code !== SUCCESS && res.code !== 1002) {
      throw new Error(`sendImage failed: ${res.message ?? res.code}`);
    }
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
      throw new Error(`getContacts failed: ${res.message ?? res.code}`);
    }
    return requireData(res, "getContacts");
  }

  async registerWebhook(url: string): Promise<void> {
    const res = await this.request("/api/webhook/register", {
      webhookUrl: url,
    });
    if (res.code !== SUCCESS && res.code !== 1002) {
      throw new Error(`registerWebhook failed: ${res.message ?? res.code}`);
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
): number {
  const fallback = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
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
  if (parsed.protocol !== "https:") {
    throw new Error("[wechat] proxyUrl must use https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("[wechat] proxyUrl must not include credentials");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function requireData<T>(response: ProxyApiResponse<T>, action: string): T {
  if (response.data === undefined) {
    throw new Error(`${action} failed: missing response data`);
  }
  return response.data;
}
