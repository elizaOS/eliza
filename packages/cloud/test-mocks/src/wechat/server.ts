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
    const url = new URL(request.url);
    const accountId = request.headers.get("x-account-id");
    const deviceType = request.headers.get("x-device-type");
    const account = accountId ? accounts.get(accountId) : undefined;
    const authenticated = Boolean(
      account &&
        request.headers.get("x-api-key") === account.apiKey &&
        deviceType === account.deviceType,
    );
    const body = await readJsonBody(request);
    requests.push({
      sequence: ++sequence,
      accountId,
      deviceType,
      method: request.method,
      path: url.pathname,
      body,
      authenticated,
    });

    if (request.method !== "POST") {
      return envelope(1405, "method not allowed", undefined, 405);
    }
    if (!authenticated || !account) {
      return envelope(1401, "unauthorized", undefined, 401);
    }

    const queued = faults.get(url.pathname);
    const fault = queued?.shift();
    if (fault) {
      if (fault.delayMs) await delay(fault.delayMs);
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
        return envelope(SUCCESS, "registered");
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
        return envelope(SUCCESS, "sent");
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
        return envelope(SUCCESS, "sent");
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
      return fetch(account.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey ?? account.apiKey,
        },
        body: JSON.stringify(payload),
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

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
      url.pathname === `/webhook/wechat/${encodeURIComponent(accountId)}`
    );
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
