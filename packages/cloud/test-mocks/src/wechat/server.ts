/** Hosts a resettable WeChat proxy protocol simulator that real connector clients reach over loopback HTTP. */

import { startFetchServer } from "../fetch-server.js";
import type {
  WechatProxyAccountSeed,
  WechatProxyFault,
  WechatProxyOutboundMessage,
  WechatProxyRequestObservation,
  WechatProxySeed,
  WechatProxySnapshot,
  WechatWebhookDeliveryOptions,
} from "./types.js";

const SUCCESS = 1000;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

interface AccountState extends WechatProxyAccountSeed {
  deviceType: "ipad" | "mac";
  loginState: "waiting" | "need_verify" | "logged_in";
  friends: Array<{ wxid: string; name: string }>;
  chatrooms: Array<{ wxid: string; name: string }>;
  webhookUrl?: string;
}

export interface RunningWechatProxyMock {
  url: string;
  port: number;
  enqueueFault(path: string, fault: WechatProxyFault): void;
  reset(seed?: WechatProxySeed): void;
  snapshot(): WechatProxySnapshot;
  deliverWebhook(
    accountId: string,
    payload: unknown,
    options?: WechatWebhookDeliveryOptions,
  ): Promise<Response>;
  stop(): Promise<void>;
}

export async function startWechatProxyMock(
  seed: WechatProxySeed,
): Promise<RunningWechatProxyMock> {
  let generation = 0;
  let currentSeed = cloneSeed(seed);
  let accounts = buildAccounts(currentSeed);
  let sequence = 0;
  let requests: WechatProxyRequestObservation[] = [];
  let outboundMessages: WechatProxyOutboundMessage[] = [];
  const faults = new Map<string, WechatProxyFault[]>();

  const server = await startFetchServer(async (request) => {
    const requestGeneration = generation;
    const url = new URL(request.url);
    const accountId = request.headers.get("x-account-id");
    const deviceType = request.headers.get("x-device-type");
    const account = accountId ? accounts.get(accountId) : undefined;
    const authenticated = Boolean(
      account &&
        request.headers.get("x-api-key") === account.apiKey &&
        deviceType === account.deviceType,
    );
    const observation: WechatProxyRequestObservation = {
      sequence: ++sequence,
      accountId,
      deviceType,
      method: request.method,
      path: url.pathname,
      body: null,
      authenticated,
    };
    requests.push(observation);
    if (request.method !== "POST") {
      return envelope(1405, "method not allowed", undefined, 405);
    }
    if (!authenticated || !account) {
      return envelope(1401, "unauthorized", undefined, 401);
    }
    if (
      !isJsonMediaType(request.headers.get("content-type")) ||
      !isIdentityEncoding(request.headers.get("content-encoding"))
    ) {
      return envelope(
        1415,
        "content-type must be application/json",
        undefined,
        415,
      );
    }

    const parsedBody = await readJsonBody(request);
    observation.body = parsedBody.ok ? parsedBody.value : null;
    if (!parsedBody.ok) {
      return envelope(
        parsedBody.tooLarge ? 1413 : 1400,
        parsedBody.tooLarge ? "payload too large" : "invalid JSON",
        undefined,
        parsedBody.tooLarge ? 413 : 400,
      );
    }
    const body = parsedBody.value;
    if (requestGeneration !== generation) {
      return envelope(1409, "stale simulator generation", undefined, 409);
    }

    const queued = faults.get(url.pathname);
    const fault = queued?.shift();
    if (fault) {
      if (fault.delayMs) await delay(fault.delayMs);
      if (requestGeneration !== generation) {
        return envelope(1409, "stale simulator generation", undefined, 409);
      }
      const headers = new Headers({ "content-type": "application/json" });
      if (fault.retryAfter !== undefined) {
        headers.set("retry-after", fault.retryAfter);
      }
      const responseBody =
        fault.rawBody ??
        JSON.stringify(fault.body ?? { code: 1500, message: "seeded fault" });
      return new Response(responseBody, {
        status: fault.status ?? 500,
        headers,
      });
    }

    switch (url.pathname) {
      case "/api/status":
        return envelope(SUCCESS, "ok", {
          valid: true,
          loginState: account.loginState,
          wcId: account.wcId,
          nickName: account.nickName,
        });
      case "/api/qrcode":
        return envelope(SUCCESS, "ok", {
          qrCodeUrl: `https://wechat.mock/qr/${encodeURIComponent(account.accountId)}`,
        });
      case "/api/check-login":
        return envelope(SUCCESS, "ok", {
          status: account.loginState,
          wcId: account.wcId,
          nickName: account.nickName,
        });
      case "/api/contacts":
        return envelope(SUCCESS, "ok", {
          friends: account.friends,
          chatrooms: account.chatrooms,
        });
      case "/api/webhook/register": {
        const webhookUrl = readString(body, "webhookUrl");
        if (
          !webhookUrl ||
          !isAllowedWebhookUrl(webhookUrl, account.accountId)
        ) {
          return envelope(1400, "invalid webhookUrl", undefined, 400);
        }
        account.webhookUrl = webhookUrl;
        return envelope(SUCCESS, "registered", { registered: true });
      }
      case "/api/send-text": {
        const to = readString(body, "to");
        const text = readString(body, "text");
        if (!to || !text)
          return envelope(1400, "invalid text message", undefined, 400);
        outboundMessages.push({
          sequence: ++sequence,
          accountId: account.accountId,
          kind: "text",
          to,
          text,
        });
        return envelope(SUCCESS, "sent", {
          accepted: true,
          operation: "sendText",
        });
      }
      case "/api/send-image": {
        const to = readString(body, "to");
        const imagePath = readString(body, "imagePath");
        if (!to || !imagePath)
          return envelope(1400, "invalid image message", undefined, 400);
        outboundMessages.push({
          sequence: ++sequence,
          accountId: account.accountId,
          kind: "image",
          to,
          imagePath,
          text: readString(body, "text") ?? undefined,
        });
        return envelope(SUCCESS, "sent", {
          accepted: true,
          operation: "sendImage",
        });
      }
      default:
        return envelope(1404, "not found", undefined, 404);
    }
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    port: server.port,
    enqueueFault(path, fault) {
      const queue = faults.get(path) ?? [];
      queue.push({ ...fault });
      faults.set(path, queue);
    },
    reset(nextSeed = currentSeed) {
      currentSeed = cloneSeed(nextSeed);
      accounts = buildAccounts(currentSeed);
      requests = [];
      outboundMessages = [];
      faults.clear();
      sequence = 0;
      generation += 1;
    },
    snapshot() {
      return {
        generation,
        requests: structuredClone(requests),
        outboundMessages: structuredClone(outboundMessages),
        webhooks: Object.fromEntries(
          [...accounts].flatMap(([accountId, account]) =>
            account.webhookUrl ? [[accountId, account.webhookUrl]] : [],
          ),
        ),
      };
    },
    async deliverWebhook(accountId, payload, options = {}) {
      const account = accounts.get(accountId);
      if (!account?.webhookUrl) {
        throw new Error(
          `WeChat mock account '${accountId}' has no registered webhook`,
        );
      }
      const timeoutMs = options.timeoutMs ?? 1000;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 30_000
      ) {
        throw new Error("WeChat webhook timeoutMs must be between 1 and 30000");
      }
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      return fetch(account.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey ?? account.apiKey,
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal,
      });
    },
    stop: server.stop,
  };
}

function buildAccounts(seed: WechatProxySeed): Map<string, AccountState> {
  if (seed.accounts.length === 0)
    throw new Error("WeChat proxy seed requires an account");
  const accounts = new Map<string, AccountState>();
  for (const entry of seed.accounts) {
    if (!entry.accountId.trim() || !entry.apiKey)
      throw new Error("invalid WeChat account seed");
    if (accounts.has(entry.accountId))
      throw new Error("duplicate WeChat account seed");
    accounts.set(entry.accountId, {
      ...structuredClone(entry),
      deviceType: entry.deviceType ?? "ipad",
      loginState: entry.loginState ?? "logged_in",
      friends: structuredClone(entry.friends ?? []),
      chatrooms: structuredClone(entry.chatrooms ?? []),
    });
  }
  return accounts;
}

function cloneSeed(seed: WechatProxySeed): WechatProxySeed {
  return structuredClone(seed);
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_BODY_BYTES
  ) {
    return { ok: false, tooLarge: true };
  }
  if (!request.body) return { ok: true, value: {} };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel("request body exceeds simulator limit");
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text) return { ok: true, value: {} };
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // error-policy:J3 invalid UTF-8 or JSON is an explicit protocol error.
    return { ok: false, tooLarge: false };
  }
}

function isJsonMediaType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function isIdentityEncoding(value: string | null): boolean {
  return value === null || value.trim().toLowerCase() === "identity";
}

function readString(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function envelope(
  code: number,
  message: string,
  data?: unknown,
  status = 200,
): Response {
  return Response.json(
    data === undefined ? { code, message } : { code, message, data },
    { status },
  );
}

function isAllowedWebhookUrl(value: string, accountId: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === `/webhook/wechat/${encodeURIComponent(accountId)}`
    );
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
