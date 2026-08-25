/**
 * Telegram webhook fail-closed auth + replay dedupe (#12227 L4, #12878).
 *
 * Two findings, both exercised against the real route handler with its
 * external dependency surface replaced by deterministic fixtures:
 *   (L4a) dev fall-open: previously, when no webhook secret was stored for an
 *         org, any non-production request fell through and processed the update
 *         with NO auth. The route now fails closed everywhere; the only bypass
 *         is the explicit, loud, env-gated
 *         `TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV`.
 *   (L4b) no dedupe: Telegram re-delivers an update until it gets a 200. The
 *         route now dedupes on `update_id` (scoped per org) via
 *         `webhookEventsRepository.tryCreate`. A replayed `update_id` is a
 *         no-op — the agent is routed to exactly once.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// ---- Dependency surface (all mocked so no real `@/` path is resolved) -------

const handleUpdate = mock(async () => undefined);

class FakeTelegraf {
  telegram = {
    getMe: mock(async () => ({ id: 42 })),
    getChatMember: mock(async () => ({ status: "member" })),
  };
  start = mock(() => undefined);
  help = mock(() => undefined);
  command = mock(() => undefined);
  on = mock(() => undefined);
  handleUpdate = handleUpdate;
}

mock.module("telegraf", () => ({ Telegraf: FakeTelegraf }));

const getWebhookSecret = mock(async (_orgId: string) => null as string | null);
const getBotToken = mock(async () => "bot-token-123" as string | null);

mock.module("@/lib/services/telegram-automation", () => ({
  telegramAutomationService: { getWebhookSecret, getBotToken },
}));
mock.module("@/lib/services/telegram-automation/app-automation", () => ({
  telegramAppAutomationService: {
    getAppsWithActiveAutomation: mock(async () => []),
    handleIncomingMessage: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routeTelegramMessage: mock(async () => ({ handled: false })),
  },
}));
mock.module("@/db/repositories/telegram-chats", () => ({
  telegramChatsRepository: {
    findByChatId: mock(async () => undefined),
    upsert: mock(async () => undefined),
    delete: mock(async () => undefined),
  },
}));

// In-memory stand-in for the dedupe store: real unique-constraint semantics.
const seen = new Set<string>();
const tryCreate = mock(async (data: { event_id: string }) => {
  if (seen.has(data.event_id)) return { created: false as const };
  seen.add(data.event_id);
  return { created: true as const, event: { id: "x" } };
});
const deleteByEventId = mock(async (eventId: string) => {
  seen.delete(eventId);
});
mock.module("@/db/repositories/webhook-events", () => ({
  webhookEventsRepository: { tryCreate, deleteByEventId },
}));

const timingSafeEqualSecret = mock((a: string, b: string) => a === b);
mock.module("@/lib/auth/cron", () => ({ timingSafeEqualSecret }));

// Faithful stand-in for nextStyleParams: reads params off the Hono context,
// exactly like the real helper (which wraps `c.req.param` in a Next-shaped
// `{ params: Promise<...> }`).
mock.module("@/lib/api/hono-next-style-params", () => ({
  nextStyleParams: (
    c: { req: { param: (n: string) => string | undefined } },
    spec: readonly { name: string }[],
  ) => {
    const obj: Record<string, string> = {};
    for (const { name } of spec) {
      const v = c.req.param(name);
      if (v !== undefined) obj[name] = v;
    }
    return { params: Promise.resolve(obj) };
  },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (b: unknown, s: number) => Response }) =>
    c.json({ error: "internal" }, 500),
}));
mock.module("@/lib/utils/telegram-helpers", () => ({
  isCommand: (text: string) => text.startsWith("/"),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

// Keep the rate-limit middleware a no-op passthrough so we test the handler.
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { AGGRESSIVE: "aggressive" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { default: tgRoute } = (await import(
  "./route"
)) as typeof import("./route");

const ORG = "org-1";

interface DeliveryOptions {
  updateId?: number;
  secretHeader?: string;
}

function delivery(opts: DeliveryOptions = {}) {
  const app = new Hono();
  app.route("/:orgId", tgRoute);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.secretHeader !== undefined) {
    headers["x-telegram-bot-api-secret-token"] = opts.secretHeader;
  }
  return app.fetch(
    new Request(`https://api.example.test/${ORG}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        update_id: opts.updateId ?? 1001,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 555, type: "private" },
          from: { id: 555, first_name: "Tester" },
          text: "hello",
        },
      }),
    }),
  );
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOW_UNVERIFIED =
  process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV;

function restoreEnv() {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ALLOW_UNVERIFIED === undefined) {
    delete process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV;
  } else {
    process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV =
      ORIGINAL_ALLOW_UNVERIFIED;
  }
}

describe("Telegram webhook — fail-closed auth (L4a)", () => {
  beforeEach(() => {
    handleUpdate.mockClear();
    getWebhookSecret.mockReset();
    getWebhookSecret.mockResolvedValue(null); // no secret stored for this org
    delete process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV;
    seen.clear();
  });
  afterEach(restoreEnv);

  test("no stored secret in dev is NOT processed (no silent fall-open)", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV;
    const res = await delivery();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "not_configured",
    });
    expect(handleUpdate).toHaveBeenCalledTimes(0);
  });

  test("no stored secret in production is NOT processed", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV;
    const res = await delivery();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "not_configured",
    });
    expect(handleUpdate).toHaveBeenCalledTimes(0);
  });

  test("explicit env bypass processes in dev (loud, opt-in)", async () => {
    process.env.NODE_ENV = "development";
    process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV = "1";
    const res = await delivery();
    expect(res.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);
  });

  test("env bypass is refused in production even when set", async () => {
    process.env.NODE_ENV = "production";
    process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV = "1";
    const res = await delivery();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "not_configured",
    });
    expect(handleUpdate).toHaveBeenCalledTimes(0);
  });

  test("valid stored secret + matching header IS processed", async () => {
    getWebhookSecret.mockResolvedValue("stored-secret");
    process.env.NODE_ENV = "production";
    const res = await delivery({ secretHeader: "stored-secret" });
    expect(res.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);
  });

  test("stored secret + wrong header is 401 (unchanged prod behavior)", async () => {
    getWebhookSecret.mockResolvedValue("stored-secret");
    process.env.NODE_ENV = "production";
    const res = await delivery({ secretHeader: "wrong-secret" });
    expect(res.status).toBe(401);
    expect(handleUpdate).toHaveBeenCalledTimes(0);
  });

  test("stored secret + missing header is 401", async () => {
    getWebhookSecret.mockResolvedValue("stored-secret");
    process.env.NODE_ENV = "production";
    const res = await delivery();
    expect(res.status).toBe(401);
    expect(handleUpdate).toHaveBeenCalledTimes(0);
  });
});

describe("Telegram webhook — replay dedupe (L4b)", () => {
  beforeEach(() => {
    handleUpdate.mockClear();
    getWebhookSecret.mockReset();
    getWebhookSecret.mockResolvedValue("stored-secret");
    process.env.NODE_ENV = "production";
    seen.clear();
  });
  afterEach(restoreEnv);

  test("first update processes; a replayed update_id is a no-op", async () => {
    const first = await delivery({
      updateId: 2002,
      secretHeader: "stored-secret",
    });
    expect(first.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);

    const replay = await delivery({
      updateId: 2002,
      secretHeader: "stored-secret",
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ status: "duplicate" });
    expect(handleUpdate).toHaveBeenCalledTimes(1);
  });

  test("a distinct update_id is processed normally", async () => {
    await delivery({ updateId: 2002, secretHeader: "stored-secret" });
    const other = await delivery({
      updateId: 3003,
      secretHeader: "stored-secret",
    });
    expect(other.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(2);
  });

  test("dedupe is scoped per org's update_id namespace", async () => {
    await delivery({ updateId: 2002, secretHeader: "stored-secret" });
    // Same update_id would collide globally, but the event_id is org-scoped.
    // Confirm the marker key carries the org prefix.
    expect(tryCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event_id: `telegram:${ORG}:2002`,
        provider: "telegram",
      }),
    );
  });

  test("a handling failure rolls back the marker so the retry reprocesses (P2)", async () => {
    // Force a throw AFTER the marker is committed: a chat-member update whose
    // handler path throws (getChatMember rejects). The route must delete the
    // dedupe marker and re-throw (5xx), and a Telegram retry of the same
    // update_id must be processed again, not short-circuited as duplicate.
    deleteByEventId.mockClear();
    const app = new Hono();
    app.route("/:orgId", tgRoute);

    const throwingBody = JSON.stringify({
      update_id: 4004,
      my_chat_member: {
        chat: { id: 777, type: "supergroup", title: "grp" },
        from: { id: 1, first_name: "x" },
        date: 0,
        old_chat_member: { status: "left", user: { id: 42 } },
        new_chat_member: { status: "member", user: { id: 42 } },
      },
    });
    // handleChatMemberUpdate -> telegramChatsRepository.upsert throws.
    const { telegramChatsRepository } = (await import(
      "@/db/repositories/telegram-chats"
    )) as unknown as {
      telegramChatsRepository: { upsert: ReturnType<typeof mock> };
    };
    telegramChatsRepository.upsert.mockImplementationOnce(async () => {
      throw new Error("db down");
    });

    const res = await app.fetch(
      new Request(`https://api.example.test/${ORG}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "stored-secret",
        },
        body: throwingBody,
      }),
    );
    // Route surfaces the error as a 5xx (failureResponse) so Telegram retries.
    expect(res.status).toBe(500);
    // The marker for this update_id was rolled back.
    expect(deleteByEventId).toHaveBeenCalledWith(
      `telegram:${ORG}:4004`,
      "telegram",
    );
    expect(seen.has(`telegram:${ORG}:4004`)).toBe(false);
  });
});
