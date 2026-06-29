import { createHmac } from "node:crypto";
import * as http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleEmbedAuthRoute } from "./embed-auth-route.ts";

const BOT_TOKEN = "123456:test-bot-token";
const NOW_SECONDS = Math.floor(Date.now() / 1000);

function signTelegramInitData(fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set(
    "hash",
    createHmac("sha256", secret).update(dataCheckString).digest("hex"),
  );
  return params.toString();
}

function fakeReq(body: unknown): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket()) as http.IncomingMessage & {
    body?: unknown;
  };
  req.method = "POST";
  req.url = "/api/embed/auth";
  req.body = body;
  return req;
}

function fakeRes() {
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  let bodyText = "";
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    body: () => (bodyText ? (JSON.parse(bodyText) as unknown) : null),
  };
}

function state(): CompatRuntimeState {
  return {
    current: {
      agentId: "00000000-0000-0000-0000-000000000001",
    } as never,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

describe("handleEmbedAuthRoute", () => {
  it("returns an embed token for a verified elevated Telegram sender", async () => {
    const res = fakeRes();
    const handled = await handleEmbedAuthRoute(
      fakeReq({
        platform: "telegram",
        signedLaunchPayload: signTelegramInitData({
          auth_date: String(NOW_SECONDS),
          user: JSON.stringify({ id: 42, username: "admin" }),
        }),
      }),
      res.res,
      state(),
      {
        telegramBotToken: BOT_TOKEN,
        sessionSecret: "embed-secret",
        roleAccess: vi
          .fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
      },
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({
      platform: "telegram",
      role: "ADMIN",
      adminMode: true,
    });
    expect((res.body() as { token?: string }).token).toMatch(/\./);
  });

  it("returns 403 for a verified Telegram sender without OWNER or ADMIN role", async () => {
    const res = fakeRes();
    await handleEmbedAuthRoute(
      fakeReq({
        platform: "telegram",
        signedLaunchPayload: signTelegramInitData({
          auth_date: String(NOW_SECONDS),
          user: JSON.stringify({ id: 42 }),
        }),
      }),
      res.res,
      state(),
      {
        telegramBotToken: BOT_TOKEN,
        sessionSecret: "embed-secret",
        roleAccess: vi.fn(async () => false),
      },
    );

    expect(res.status()).toBe(403);
    expect(res.body()).toEqual({ error: "insufficient_role" });
  });

  it("returns 400 for malformed requests", async () => {
    const res = fakeRes();
    await handleEmbedAuthRoute(
      fakeReq({ platform: "telegram" }),
      res.res,
      state(),
      { telegramBotToken: BOT_TOKEN, sessionSecret: "embed-secret" },
    );

    expect(res.status()).toBe(400);
    expect(res.body()).toEqual({ error: "invalid_embed_auth_request" });
  });
});
