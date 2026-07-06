/**
 * Real-connector proof for the Telegram sensitive-request DM link-out (#14326).
 *
 * The security-sensitive path this covers: an agent needs a secret / OAuth
 * consent from a group chat where an inline widget cannot render, so it DMs the
 * user a single tap-through link to a hosted authenticated page; the value is
 * collected there and never typed into the chat transport. This exercises the
 * REAL production adapter (`telegramDmSensitiveRequestAdapter`) end-to-end over
 * a REAL Telegraf client doing a REAL HTTP round-trip to a local stand-in Bot
 * API server — so the exact bytes Telegram would receive are captured and the
 * "no secret material transits chat" invariant is asserted against the actual
 * serialized wire payload, not a hand-rolled stub of it. The merged headless
 * e2e (`packages/cloud/shared/.../sensitive-request-hosted-page-e2e.test.ts`)
 * proves the service/token/callback leg; this file proves the connector leg the
 * issue's remaining acceptance criterion calls out. The only thing not real
 * here is the Bot API host (local server, not api.telegram.org) and the human
 * who taps the link — that final live round-trip is owner-run and gated in the
 * hosted-page e2e.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Telegraf } from "telegraf";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSensitiveRequestDispatchRegistry,
  type DispatchSensitiveRequest,
  type SensitiveRequestDeliveryAdapter,
} from "../../../packages/core/src/sensitive-requests/dispatch-registry";
import { telegramDmSensitiveRequestAdapter } from "./sensitive-request-adapter";

// A benign token — the local server accepts anything; only the URL path shape
// (`/bot<token>/sendMessage`) and JSON body matter.
const BOT_TOKEN = "999999999:AA_test_dummy_telegram_bot_token";
const CHAT_ID = "123456789";
const HOSTED_LINK = "https://cloud.example.ai/sensitive-requests/req-tg-1";
// Placed in request fields the adapter must NOT serialize. If the raw wire body
// ever contains this, the connector leaked secret-adjacent material.
const SECRET_SENTINEL = "sk-live-DO-NOT-LEAK-telegram-0987654321";

interface CapturedCall {
  path: string;
  method: string;
  contentType: string | undefined;
  body: string;
  parsed: Record<string, unknown>;
}

/**
 * A minimal, faithful stand-in for the Telegram Bot API. Real Telegraf serializes
 * and POSTs to it over HTTP; we capture the exact request and reply with the
 * `{ ok: true, result: <Message> }` envelope Telegraf's client (telegraf 4.16.3,
 * `core/network/client.ts`) requires. `mode` lets a test force the blocked-by-user
 * error path (HTTP 200 + `ok:false`, which Telegraf turns into a thrown error).
 */
class MockBotApi {
  readonly calls: CapturedCall[] = [];
  mode: "ok" | "blocked" = "ok";
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server?.close((err) => (err ? reject(err) : resolve())),
    );
  }

  reset(): void {
    this.calls.length = 0;
    this.mode = "ok";
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        // error-policy:J3 untrusted body — record raw, leave parsed empty so the
        // test can still assert on the wire bytes.
        parsed = {};
      }
      this.calls.push({
        path: req.url ?? "",
        method: req.method ?? "",
        contentType: req.headers["content-type"],
        body,
        parsed,
      });
      res.setHeader("content-type", "application/json");
      if (this.mode === "blocked") {
        // Real Telegram response when the user has blocked the bot. HTTP 200 with
        // ok:false is exactly what Telegraf surfaces as a TelegramError.
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 403,
            description: "Forbidden: bot was blocked by the user",
          }),
        );
        return;
      }
      const chatId = Number((parsed as { chat_id?: unknown }).chat_id);
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 42,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private" },
            text: (parsed as { text?: string }).text ?? "",
          },
        }),
      );
    });
  }
}

let mockApi: MockBotApi;
let apiRoot: string;

function makeTelegramRuntime(): { getService: (name: string) => unknown } {
  // A real Telegraf client, pointed at the local Bot API. Wrapped in the exact
  // `{ bot }` shape the adapter's `getTelegramBot` looks up under the "telegram"
  // service — so the adapter drives the genuine telegraf send path.
  const bot = new Telegraf(BOT_TOKEN, { telegram: { apiRoot } });
  return {
    getService: (name: string) => (name === "telegram" ? { bot } : null),
  };
}

function makeRequest(
  overrides: Partial<DispatchSensitiveRequest> = {},
): DispatchSensitiveRequest {
  return {
    id: "req-tg-1",
    kind: "secret",
    expiresAt: "2099-01-01T00:00:00.000Z",
    // The hosted link the connector DMs. Production populates this via the
    // secrets/oauth feature (cloud-authenticated link when Cloud is linked).
    callback: { url: HOSTED_LINK },
    delivery: { reason: "The agent needs your OpenAI API key to continue." },
    // Secret-adjacent material the adapter must never put on the wire.
    secretValue: SECRET_SENTINEL,
    ...overrides,
  } as DispatchSensitiveRequest;
}

beforeAll(async () => {
  mockApi = new MockBotApi();
  apiRoot = await mockApi.start();
});

afterAll(async () => {
  await mockApi.stop();
});

afterEach(() => {
  mockApi.reset();
});

describe("#14326 telegramDmSensitiveRequestAdapter — real connector transport", () => {
  it("declares the 'dm' target and only supports the channel when the Telegram bot is live", () => {
    expect(telegramDmSensitiveRequestAdapter.target).toBe("dm");
    // Present service → claims the DM channel.
    expect(
      telegramDmSensitiveRequestAdapter.supportsChannel?.(
        CHAT_ID,
        makeTelegramRuntime(),
      ),
    ).toBe(true);
    // No Telegram service → does not claim it, so the registry falls through to
    // another connector's "dm" adapter.
    expect(
      telegramDmSensitiveRequestAdapter.supportsChannel?.(CHAT_ID, {
        getService: () => null,
      }),
    ).toBe(false);
  });

  it("the real dispatch registry resolves 'dm' to Telegram over a sibling connector for a Telegram chat", async () => {
    const registry = createSensitiveRequestDispatchRegistry();
    // A Discord-like sibling that claims only its own transport. Registering both
    // under "dm" is the collision the registry resolves per channel.
    const discordLike: SensitiveRequestDeliveryAdapter = {
      target: "dm",
      supportsChannel: (_ch, runtime) =>
        Boolean(
          (runtime as { getService?: (n: string) => unknown })?.getService?.(
            "discord",
          ),
        ),
      deliver: async () => ({ delivered: true, target: "dm" }),
    };
    registry.register(discordLike);
    registry.register(telegramDmSensitiveRequestAdapter);

    const runtime = makeTelegramRuntime();
    const resolved = registry.resolve?.("dm", CHAT_ID, runtime);
    expect(resolved).toBe(telegramDmSensitiveRequestAdapter);
  });

  it("delivers a secret link-out DM over a real Telegraf HTTP round-trip; the link is on the wire, the secret is not", async () => {
    const runtime = makeTelegramRuntime();

    const result = await telegramDmSensitiveRequestAdapter.deliver({
      request: makeRequest(),
      channelId: CHAT_ID,
      runtime,
    });

    // The adapter reports a real delivery with the link it handed off.
    expect(result.delivered).toBe(true);
    expect(result.target).toBe("dm");
    expect(result.channelId).toBe(CHAT_ID);
    expect(result.url).toBe(HOSTED_LINK);

    // A real HTTP POST reached the Bot API at the sendMessage endpoint.
    expect(mockApi.calls).toHaveLength(1);
    const call = mockApi.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe(`/bot${BOT_TOKEN}/sendMessage`);
    expect(call.contentType).toContain("application/json");

    // The message targets the right chat and carries the tap-through link button.
    expect(call.parsed.chat_id).toBe(Number(CHAT_ID));
    const replyMarkup = call.parsed.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; url: string }>>;
    };
    expect(replyMarkup.inline_keyboard[0][0].url).toBe(HOSTED_LINK);
    expect(replyMarkup.inline_keyboard[0][0].text).toBe("Provide securely");
    expect(String(call.parsed.text)).toContain(
      "A sensitive value is needed to continue.",
    );

    // The invariant: the exact bytes on the wire carry the link but never the
    // secret-adjacent material attached to the request.
    expect(call.body).toContain(HOSTED_LINK);
    expect(call.body).not.toContain(SECRET_SENTINEL);
  });

  it("labels the button 'Connect <provider>' for an OAuth consent link-out", async () => {
    const runtime = makeTelegramRuntime();

    await telegramDmSensitiveRequestAdapter.deliver({
      request: makeRequest({
        kind: "oauth",
        provider: "google",
        callback: { url: HOSTED_LINK },
        delivery: { reason: "Connect Google to read your calendar." },
      }),
      channelId: CHAT_ID,
      runtime,
    });

    const replyMarkup = mockApi.calls[0].parsed.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; url: string }>>;
    };
    expect(replyMarkup.inline_keyboard[0][0].text).toBe("Connect google");
    expect(replyMarkup.inline_keyboard[0][0].url).toBe(HOSTED_LINK);
  });

  it("sends a plain-text fallback with no button when no link is available", async () => {
    const runtime = makeTelegramRuntime();

    const result = await telegramDmSensitiveRequestAdapter.deliver({
      request: makeRequest({
        callback: {},
        delivery: {
          reason: "A value is required.",
          instruction: "Open the Eliza app.",
        },
      }),
      channelId: CHAT_ID,
      runtime,
    });

    expect(result.delivered).toBe(true);
    expect(result.url).toBeUndefined();
    const call = mockApi.calls[0];
    expect(call.parsed.reply_markup).toBeUndefined();
    expect(String(call.parsed.text)).toContain("Open the Eliza app.");
  });

  it("fails closed with no HTTP call when no Telegram bot is available", async () => {
    const result = await telegramDmSensitiveRequestAdapter.deliver({
      request: makeRequest(),
      channelId: CHAT_ID,
      runtime: { getService: () => null },
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toBe("Telegram service unavailable");
    expect(mockApi.calls).toHaveLength(0);
  });

  it("rejects a non-numeric Telegram user id before any send", async () => {
    const runtime = makeTelegramRuntime();

    const result = await telegramDmSensitiveRequestAdapter.deliver({
      request: makeRequest(),
      channelId: "not-a-telegram-id",
      runtime,
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/No Telegram user id available/);
    expect(mockApi.calls).toHaveLength(0);
  });

  it("surfaces a delivery failure when the recipient has blocked the bot", async () => {
    const runtime = makeTelegramRuntime();
    mockApi.mode = "blocked";

    const result = await telegramDmSensitiveRequestAdapter.deliver({
      request: makeRequest(),
      channelId: CHAT_ID,
      runtime,
    });

    // The real HTTP call happened and returned Telegram's 403; the adapter turns
    // it into a structured failure rather than throwing.
    expect(mockApi.calls).toHaveLength(1);
    expect(result.delivered).toBe(false);
    expect(result.target).toBe("dm");
    expect(result.error).toMatch(/blocked by the user/i);
  });
});
