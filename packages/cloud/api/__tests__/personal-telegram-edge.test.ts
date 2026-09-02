/** Drives the edge Telegram connector through Hono with real shared state-machine code. */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { PERSONAL_SHARED_FAILURE_REPLY } from "@elizaos/cloud-services-common/personal-shared-failure";
import { __resetTelegramIdentityAttestationCacheForTests } from "@elizaos/cloud-services-common/telegram-connector";
import { Hono } from "hono";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import {
  dispatchPersonalTelegramReminder,
  handlePersonalTelegramEdge,
  type TelegramEdgeDeps,
} from "../eliza-app/webhook/_telegram-edge";
import telegramRoute from "../eliza-app/webhook/telegram/route";

const TRACE_ID = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;

function testBotUsername(botId: string): string {
  return botId === "456" ? "OtherTestBot" : "ElizaTestBot";
}

function telegramBindings(
  botToken = "123:test-token",
): Pick<
  AppEnv["Bindings"],
  | "ELIZA_APP_TELEGRAM_BOT_TOKEN"
  | "ELIZA_APP_TELEGRAM_BOT_ID"
  | "ELIZA_APP_TELEGRAM_BOT_USERNAME"
  | "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET"
> {
  const botId = botToken.match(/^([1-9]\d*):/)?.[1] ?? "";
  return {
    ELIZA_APP_TELEGRAM_BOT_TOKEN: botToken,
    ELIZA_APP_TELEGRAM_BOT_ID: botId,
    ELIZA_APP_TELEGRAM_BOT_USERNAME: testBotUsername(botId),
    ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
  };
}

function telegramGetMeResponse(
  input: RequestInfo | URL,
  overrides: Record<string, unknown> = {},
): Response {
  const botId = String(input).match(/\/bot([1-9]\d*):/)?.[1] ?? "123";
  return Response.json({
    ok: true,
    result: {
      id: Number(botId),
      is_bot: true,
      username: testBotUsername(botId),
      ...overrides,
    },
  });
}

interface LedgerValue {
  delivery?: "uncertain" | "delivered";
  processing?: boolean;
  plan?: string[];
  chunks?: Map<number, "uncertain" | "delivered">;
  acceptedAt?: string;
  providerMessageIds?: string[];
}

type RunTurn = NonNullable<
  Parameters<typeof handlePersonalTelegramEdge>[1]
>["runTurn"];

function namespace(): {
  binding: AppEnv["Bindings"]["PERSONAL_TELEGRAM_DELIVERIES"];
  values: Map<string, LedgerValue>;
  names: string[];
} {
  const values = new Map<string, LedgerValue>();
  const names: string[] = [];
  return {
    values,
    names,
    binding: {
      getByName(name: string) {
        names.push(name);
        return {
          async fetch(_input: RequestInfo | URL, init?: RequestInit) {
            const body = JSON.parse(String(init?.body)) as {
              messageId: string;
              operation: string;
              chunkDigests?: string[];
              chunkIndex?: number;
              chunkDigest?: string;
              providerMessageId?: string;
            };
            const key = `${name}:${body.messageId}`;
            const value = values.get(key) ?? {};
            if (body.operation === "read") {
              return Response.json({ state: value.delivery ?? null });
            }
            if (body.operation === "read_receipt") {
              return Response.json({
                acceptedAt: value.acceptedAt ?? null,
                providerMessageIds: value.providerMessageIds ?? [],
              });
            }
            if (body.operation === "claim_processing") {
              if (value.processing) return Response.json({ claimed: false });
              value.processing = true;
              values.set(key, value);
              return Response.json({ claimed: true });
            }
            if (body.operation === "release_processing") {
              value.processing = false;
              values.set(key, value);
              return Response.json({ released: true });
            }
            if (body.operation === "prepare_plan") {
              if (
                value.plan &&
                value.plan.join(":") !== body.chunkDigests?.join(":")
              ) {
                return Response.json({ plan: "conflict" });
              }
              value.plan = body.chunkDigests ?? [];
              values.set(key, value);
              return Response.json({ plan: "prepared" });
            }
            const chunkIndex = body.chunkIndex ?? -1;
            value.chunks ??= new Map();
            if (body.operation === "read_chunk") {
              return Response.json({
                state: value.chunks.get(chunkIndex) ?? null,
              });
            }
            if (body.operation === "claim_chunk") {
              if (value.chunks.has(chunkIndex)) {
                return Response.json({ claimed: false });
              }
              value.chunks.set(chunkIndex, "uncertain");
              values.set(key, value);
              return Response.json({ claimed: true });
            }
            if (body.operation === "release_chunk") {
              value.chunks.delete(chunkIndex);
              values.set(key, value);
              return Response.json({ released: true });
            }
            if (body.operation === "mark_chunk_delivered") {
              value.chunks.set(chunkIndex, "delivered");
              if (body.providerMessageId) {
                value.acceptedAt ??= new Date().toISOString();
                value.providerMessageIds = Array.from(
                  new Set([
                    ...(value.providerMessageIds ?? []),
                    body.providerMessageId,
                  ]),
                );
              }
              values.set(key, value);
              return Response.json({ delivered: true });
            }
            value.delivery =
              body.operation === "mark_uncertain" ? "uncertain" : "delivered";
            values.set(key, value);
            return Response.json({ delivered: true });
          },
        };
      },
    },
  };
}

function telegramRequest(updateId = 81601, text = "hey how are you?"): Request {
  return new Request("https://api-staging.eliza.app/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId - 80000,
        date: Math.floor(Date.now() / 1000),
        from: { id: 123456, first_name: "Nubs" },
        chat: { id: 123456, type: "private" },
        text,
      },
    }),
  });
}

function telegramGroupRequest(updateId = 81621, text = "hey group"): Request {
  return new Request("https://api-staging.eliza.app/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId - 80000,
        date: Math.floor(Date.now() / 1000),
        from: { id: 123456, first_name: "Nubs" },
        chat: { id: -100123456789, type: "supergroup" },
        text,
      },
    }),
  });
}

function telegramMembershipRequest(updateId = 81622): Request {
  return new Request("https://api-staging.eliza.app/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
    },
    body: JSON.stringify({
      update_id: updateId,
      my_chat_member: {
        date: Math.floor(Date.now() / 1000),
        from: { id: 123456, first_name: "Nubs" },
        chat: { id: -100123456789, type: "supergroup" },
        new_chat_member: { status: "member" },
      },
    }),
  });
}

function telegramVoiceRequest(updateId = 81620): Request {
  return new Request("https://api-staging.eliza.app/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId - 80000,
        date: Math.floor(Date.now() / 1000),
        from: { id: 123456, first_name: "Nubs" },
        chat: { id: 123456, type: "private" },
        voice: {
          file_id: "voice-file-1",
          duration: 2,
          file_size: 128,
          mime_type: "audio/ogg",
        },
      },
    }),
  });
}

function executionContext(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  } as unknown as ExecutionContext;
}

async function run(
  ledger: ReturnType<typeof namespace>,
  runTurn: RunTurn,
  request = telegramRequest(),
  confirmIdentityLink?: TelegramEdgeDeps["confirmIdentityLink"],
  botToken = "123:test-token",
  getMeOverrides: Record<string, unknown> = {},
): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("traceId", TRACE_ID);
    await next();
  });
  app.post("/", (c) =>
    handlePersonalTelegramEdge(c as AppContext, {
      runTurn,
      confirmIdentityLink,
    }),
  );
  app.onError(() => Response.json({ error: "failed" }, { status: 500 }));
  const providerFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) =>
    String(input).endsWith("/getMe")
      ? Promise.resolve(telegramGetMeResponse(input, getMeOverrides))
      : providerFetch(input, init)) as typeof fetch;
  try {
    return await app.fetch(
      request,
      {
        ...telegramBindings(botToken),
        ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
        PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
      } as AppEnv["Bindings"],
      executionContext(),
    );
  } finally {
    globalThis.fetch = providerFetch;
  }
}

beforeEach(() => {
  globalThis.fetch = mock(async (input) => {
    if (String(input).endsWith("/getMe")) {
      return telegramGetMeResponse(input);
    }
    throw new Error("unexpected provider call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetTelegramIdentityAttestationCacheForTests();
  mock.restore();
});

describe("Personal Shared Telegram edge", () => {
  test("delivers reminders with the edge bot and returns a durable duplicate receipt", async () => {
    const ledger = namespace();
    let sends = 0;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).endsWith("/getMe")) {
        return telegramGetMeResponse(input);
      }
      if (String(input).endsWith("/sendMessage")) {
        sends += 1;
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return Response.json({ ok: true, result: { message_id: 9010 } });
    }) as unknown as typeof fetch;
    const env = {
      ...telegramBindings(),
      ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
      PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
    } as AppEnv["Bindings"];
    const input = {
      project: "eliza-app",
      connectorAccountId: "bot:123",
      chatId: "123456",
      text: "time to stretch",
      idempotencyKey: "reminder-1:2026-08-20T19:30:00.000Z",
    };

    const delivered = await dispatchPersonalTelegramReminder(env, input);
    const duplicate = await dispatchPersonalTelegramReminder(env, input);

    expect(delivered).toMatchObject({ ok: true, providerMessageIds: ["9010"] });
    expect(duplicate).toEqual(delivered);
    expect(sends).toBe(1);
    expect(bodies).toEqual([
      {
        chat_id: "123456",
        text: "time to stretch",
        parse_mode: "Markdown",
      },
    ]);
  });

  test("delivers a Telegram group reminder inside its forum topic once", async () => {
    const ledger = namespace();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (input, init) => {
      if (String(input).endsWith("/getMe")) {
        return telegramGetMeResponse(input);
      }
      if (String(input).endsWith("/sendMessage")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return Response.json({ ok: true, result: { message_id: 9011 } });
    }) as unknown as typeof fetch;
    const env = {
      ...telegramBindings(),
      ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
      PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
    } as AppEnv["Bindings"];
    const input = {
      project: "eliza-app",
      connectorAccountId: "bot:123",
      chatId: "-100123456789",
      providerThreadId: "909",
      text: "time to stretch",
      idempotencyKey: "reminder-topic-1:2026-08-20T19:30:00.000Z",
    };

    const delivered = await dispatchPersonalTelegramReminder(env, input);
    const duplicate = await dispatchPersonalTelegramReminder(env, input);

    expect(delivered).toMatchObject({ ok: true, providerMessageIds: ["9011"] });
    expect(duplicate).toEqual(delivered);
    expect(bodies).toEqual([
      {
        chat_id: "-100123456789",
        message_thread_id: 909,
        text: "time to stretch",
        parse_mode: "Markdown",
      },
    ]);
  });

  test("rejects invalid reminder topic ids before state or egress", async () => {
    const ledger = namespace();
    globalThis.fetch = mock(async () => {
      throw new Error("egress must not run");
    }) as unknown as typeof fetch;
    const env = {
      ...telegramBindings(),
      PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
    } as AppEnv["Bindings"];

    for (const providerThreadId of ["0", "0909", "topic", "9999999999999999"]) {
      await expect(
        dispatchPersonalTelegramReminder(env, {
          project: "eliza-app",
          connectorAccountId: "bot:123",
          chatId: "-100123456789",
          providerThreadId,
          text: "time to stretch",
          idempotencyKey: `invalid-topic:${providerThreadId}`,
        }),
      ).resolves.toEqual({
        ok: false,
        acceptance: "not_accepted",
        message: "Telegram reminder topic is invalid",
      });
    }
    expect(ledger.names).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("rejects a mismatched reminder bot before ledger or message egress", async () => {
    const ledger = namespace();
    const provider = mock(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/getMe")) {
        return telegramGetMeResponse(input, { username: "WrongTestBot" });
      }
      throw new Error("message egress must not run");
    });
    globalThis.fetch = provider as unknown as typeof fetch;

    const result = await dispatchPersonalTelegramReminder(
      {
        ...telegramBindings(),
        ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
        PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
      } as AppEnv["Bindings"],
      {
        project: "eliza-app",
        connectorAccountId: "bot:123",
        chatId: "123456",
        text: "must not send",
        idempotencyKey: "reminder-identity-mismatch",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      acceptance: "not_accepted",
    });
    expect(ledger.names).toHaveLength(0);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(String(provider.mock.calls[0]?.[0])).toEndWith("/getMe");
  });

  test("pins reminder delivery to its originating stable bot account", async () => {
    const ledger = namespace();
    let sends = 0;
    globalThis.fetch = mock(async (input) => {
      if (String(input).endsWith("/getMe")) {
        return telegramGetMeResponse(input);
      }
      if (String(input).endsWith("/sendMessage")) sends += 1;
      return Response.json({
        ok: true,
        result: { message_id: 9020 + sends },
      });
    }) as unknown as typeof fetch;
    const env = (botToken: string) =>
      ({
        ...telegramBindings(botToken),
        ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
        PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
      }) as AppEnv["Bindings"];
    const input = {
      project: "eliza-app",
      connectorAccountId: "bot:123",
      chatId: "123456",
      text: "time to stretch",
      idempotencyKey: "reminder-rotation-1:2026-08-24T14:30:00.000Z",
    };

    const delivered = await dispatchPersonalTelegramReminder(
      env("123:old-secret"),
      input,
    );
    const rotatedDuplicate = await dispatchPersonalTelegramReminder(
      env("123:rotated-secret"),
      input,
    );
    const otherBot = await dispatchPersonalTelegramReminder(
      env("456:other-secret"),
      input,
    );

    expect(delivered).toMatchObject({ ok: true, providerMessageIds: ["9021"] });
    expect(rotatedDuplicate).toEqual(delivered);
    expect(otherBot).toMatchObject({
      ok: false,
      acceptance: "not_accepted",
    });
    expect(sends).toBe(1);
    expect(new Set(ledger.names)).toEqual(
      new Set(["telegram:eliza-app:personal-shared:bot:123:123456"]),
    );
  });

  test("runs the canonical turn and Telegram egress once without a Railway hop", async () => {
    const ledger = namespace();
    const turn = mock(async () =>
      Response.json(
        { data: { reply: "Doing well — what are we fixing?" } },
        { headers: { "Server-Timing": "account;dur=4, shared;dur=90" } },
      ),
    );
    const providerMethods: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      providerMethods.push(url.split("/").at(-1) ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        text?: string;
      };
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9001 } : true,
      });
    }) as unknown as typeof fetch;

    const first = await run(ledger, turn);
    const duplicate = await run(ledger, turn);

    expect(first.status).toBe(200);
    expect(first.headers.get("Server-Timing")).toContain("personal_edge_turn");
    expect(duplicate.status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(
      providerMethods.filter((method) => method === "sendMessage"),
    ).toHaveLength(1);
    expect(providerMethods).not.toContain("webhook");
  });

  test("retries only the rejected chunk for a multi-chunk reply containing newlines", async () => {
    const ledger = namespace();
    const firstChunk = `${"a".repeat(4094)}\n\n`;
    const secondChunk = "retry tail";
    const reply = `${firstChunk}${secondChunk}`;
    const turn = mock(async () => Response.json({ data: { reply } }));
    const sentTexts: string[] = [];
    let rejectedTail = false;
    globalThis.fetch = mock(async (input, init) => {
      if (!String(input).endsWith("/sendMessage")) {
        return Response.json({ ok: true, result: true });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        text?: string;
      };
      const text = body.text ?? "";
      sentTexts.push(text);
      if (text === secondChunk && !rejectedTail) {
        rejectedTail = true;
        return Response.json(
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: chat not found",
          },
          { status: 400 },
        );
      }
      return Response.json({
        ok: true,
        result: { message_id: 9100 + sentTexts.length },
      });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramRequest(81613))).status).toBe(500);
    expect((await run(ledger, turn, telegramRequest(81613))).status).toBe(200);

    expect(turn).toHaveBeenCalledTimes(2);
    expect(sentTexts).toEqual([firstChunk, secondChunk, secondChunk]);
    expect(firstChunk).toHaveLength(4096);
  });

  test("deduplicates a rotated secret for the same bot in one Durable Object namespace", async () => {
    const ledger = namespace();
    const bodies: Record<string, unknown>[] = [];
    let sends = 0;
    const turn = mock(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return Response.json({ data: { reply: "Account-scoped reply" } });
    });
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) sends += 1;
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9011 } : true,
      });
    }) as unknown as typeof fetch;

    expect(
      (
        await run(
          ledger,
          turn,
          telegramRequest(81609),
          undefined,
          "123:old-secret",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await run(
          ledger,
          turn,
          telegramRequest(81609),
          undefined,
          "123:rotated-secret",
        )
      ).status,
    ).toBe(200);

    expect(turn).toHaveBeenCalledTimes(1);
    expect(sends).toBe(1);
    expect(bodies).toEqual([
      expect.objectContaining({
        connectorAccountId: "bot:123",
        messageId: "telegram:eliza-app:bot:123:81609",
      }),
    ]);
    expect(new Set(ledger.names)).toEqual(
      new Set(["telegram:eliza-app:personal-shared:bot:123:123456"]),
    );
  });

  test("isolates different bots with the same sender and Telegram update id", async () => {
    const ledger = namespace();
    const bodies: Record<string, unknown>[] = [];
    let sends = 0;
    const turn = mock(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return Response.json({ data: { reply: "Account-scoped reply" } });
    });
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) sends += 1;
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9013 + sends } : true,
      });
    }) as unknown as typeof fetch;

    expect(
      (
        await run(
          ledger,
          turn,
          telegramRequest(81610),
          undefined,
          "123:first-secret",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await run(
          ledger,
          turn,
          telegramRequest(81610),
          undefined,
          "456:second-secret",
        )
      ).status,
    ).toBe(200);

    expect(turn).toHaveBeenCalledTimes(2);
    expect(sends).toBe(2);
    expect(bodies).toEqual([
      expect.objectContaining({
        connectorAccountId: "bot:123",
        messageId: "telegram:eliza-app:bot:123:81610",
      }),
      expect.objectContaining({
        connectorAccountId: "bot:456",
        messageId: "telegram:eliza-app:bot:456:81610",
      }),
    ]);
    expect(new Set(ledger.names)).toEqual(
      new Set([
        "telegram:eliza-app:personal-shared:bot:123:123456",
        "telegram:eliza-app:personal-shared:bot:456:123456",
      ]),
    );
  });

  test("does not import an ambiguous account-independent tombstone into epoch 2", async () => {
    const ledger = namespace();
    ledger.values.set("telegram:eliza-app:personal-shared:123456:81612", {
      delivery: "delivered",
    });
    const turn = mock(async () =>
      Response.json({ data: { reply: "Fresh bot reply" } }),
    );
    let sends = 0;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) sends += 1;
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9015 } : true,
      });
    }) as unknown as typeof fetch;

    expect(
      (
        await run(
          ledger,
          turn,
          telegramRequest(81612),
          undefined,
          "456:new-bot-secret",
        )
      ).status,
    ).toBe(200);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(sends).toBe(1);
    expect(new Set(ledger.names)).toEqual(
      new Set(["telegram:eliza-app:personal-shared:bot:456:123456"]),
    );
  });

  test("rejects an opaque Telegram credential before state or turn work", async () => {
    const botToken = "opaque-test-credential";
    const ledger = namespace();
    const turn = mock(async () =>
      Response.json({ data: { reply: "must not run" } }),
    );

    const response = await run(
      ledger,
      turn,
      telegramRequest(81611),
      undefined,
      botToken,
    );

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(botToken);
    expect(turn).not.toHaveBeenCalled();
    expect(ledger.names).toHaveLength(0);
  });

  test("delivers one fallback after retryable turn attempts are exhausted", async () => {
    const ledger = namespace();
    const turn = mock(async () =>
      Response.json(
        { error: "private upstream detail" },
        {
          status: 503,
          headers: {
            "Retry-After": "0",
            "X-Eliza-Failure-Stage": "shared_runtime",
            "X-Eliza-Failure-Name": "SharedRuntimeTurnError",
            "X-Eliza-Failure-Cause-Name":
              "SharedRuntimeProviderUnavailableError",
            "X-Eliza-Retryable": "true",
          },
        },
      ),
    );
    const sentTexts: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) sentTexts.push(body.text);
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9002 } : true,
      });
    }) as unknown as typeof fetch;

    const first = await run(ledger, turn, telegramRequest(81602));
    const duplicate = await run(ledger, turn, telegramRequest(81602));

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(3);
    expect(sentTexts).toEqual([PERSONAL_SHARED_FAILURE_REPLY]);
    expect(JSON.stringify(sentTexts)).not.toContain("private upstream detail");
  });

  test("does not replay a terminal turn before delivering one fallback", async () => {
    const ledger = namespace();
    const turn = mock(async () =>
      Response.json(
        { error: "private action detail" },
        {
          status: 500,
          headers: {
            "X-Eliza-Failure-Stage": "shared_runtime",
            "X-Eliza-Failure-Name": "SharedRuntimeTurnError",
            "X-Eliza-Failure-Cause-Name": "SharedRuntimeActionContractError",
            "X-Eliza-Retryable": "false",
          },
        },
      ),
    );
    const sentTexts: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) sentTexts.push(body.text);
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9003 } : true,
      });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramRequest(81614))).status).toBe(200);
    expect((await run(ledger, turn, telegramRequest(81614))).status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(sentTexts).toEqual([PERSONAL_SHARED_FAILURE_REPLY]);
    expect(JSON.stringify(sentTexts)).not.toContain("private action detail");
  });

  test.each([
    ["group message", telegramGroupRequest(), 200, 0],
    ["membership update", telegramMembershipRequest(), 500, 1],
  ])(
    "does not inject a private fallback for a %s",
    async (_name, request, expectedStatus, expectedTurnCalls) => {
      const turn = mock(async () =>
        Response.json(
          { error: "private action detail" },
          {
            status: 500,
            headers: {
              "X-Eliza-Failure-Stage": "shared_runtime",
              "X-Eliza-Failure-Name": "SharedRuntimeTurnError",
              "X-Eliza-Failure-Cause-Name": "SharedRuntimeActionContractError",
              "X-Eliza-Retryable": "false",
            },
          },
        ),
      );
      const sentTexts: string[] = [];
      const providerMethods: string[] = [];
      globalThis.fetch = mock(async (input, init) => {
        providerMethods.push(String(input).split("/").at(-1) ?? "");
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          text?: string;
        };
        if (body.text) sentTexts.push(body.text);
        return Response.json({ ok: true, result: { message_id: 9008 } });
      }) as unknown as typeof fetch;

      expect((await run(namespace(), turn, request)).status).toBe(
        expectedStatus,
      );
      expect(turn).toHaveBeenCalledTimes(expectedTurnCalls);
      expect(sentTexts).toEqual([]);
      expect(providerMethods).toEqual([]);
    },
  );

  test("reopens a rejected fallback send without claiming ambiguous delivery", async () => {
    const ledger = namespace();
    const turn = mock(
      async () =>
        new Response("terminal", {
          status: 500,
          headers: { "X-Eliza-Retryable": "false" },
        }),
    );
    let rejectFallback = true;
    let acceptedFallbacks = 0;
    globalThis.fetch = mock(async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (String(input).endsWith("/sendMessage") && body.text) {
        if (rejectFallback) {
          rejectFallback = false;
          return Response.json({
            ok: false,
            error_code: 400,
            description: "provider rejected message",
          });
        }
        acceptedFallbacks += 1;
        return Response.json({ ok: true, result: { message_id: 9007 } });
      }
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramRequest(81617))).status).toBe(500);
    expect((await run(ledger, turn, telegramRequest(81617))).status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(2);
    expect(acceptedFallbacks).toBe(1);
  });

  test("refuses replay when fallback acceptance becomes ambiguous", async () => {
    const ledger = namespace();
    const turn = mock(
      async () =>
        new Response("terminal", {
          status: 500,
          headers: { "X-Eliza-Retryable": "false" },
        }),
    );
    globalThis.fetch = mock(async (input) => {
      if (String(input).endsWith("/sendMessage")) {
        throw new Error("provider accepted but response was lost");
      }
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramRequest(81618))).status).toBe(500);
    expect((await run(ledger, turn, telegramRequest(81618))).status).toBe(503);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  test("delivers one exact-once fallback after transport attempts are exhausted", async () => {
    const ledger = namespace();
    const info = spyOn(logger, "info").mockImplementation(() => undefined);
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const turn = mock(async () => {
      throw new TypeError("private transport detail");
    });
    const sentTexts: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) sentTexts.push(body.text);
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9004 } : true,
      });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramRequest(81615))).status).toBe(200);
    expect((await run(ledger, turn, telegramRequest(81615))).status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(3);
    expect(sentTexts).toEqual([PERSONAL_SHARED_FAILURE_REPLY]);
    expect(JSON.stringify(sentTexts)).not.toContain("private transport detail");
    expect(warn).toHaveBeenCalledWith(
      "[PersonalTelegramEdge] pre-egress turn failed; sending safe fallback",
      expect.objectContaining({ attempts: 3 }),
    );
    expect(info).toHaveBeenCalledWith(
      "[PersonalTelegramEdge] connector message completed",
      expect.objectContaining({ attempts: 3, fallbackDelivered: true }),
    );
  });

  test("propagates an unexpected turn fault without sending a fallback", async () => {
    const ledger = namespace();
    const turn = mock(async () => {
      throw new RangeError("unexpected programmer fault");
    });
    const sentTexts: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) sentTexts.push(body.text);
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramRequest(81623))).status).toBe(500);
    expect(turn).toHaveBeenCalledTimes(3);
    expect(sentTexts).toEqual([]);
  });

  test.each([
    ["malformed JSON", () => new Response("not json")],
    ["missing reply", () => Response.json({ data: {} })],
  ])(
    "delivers one fallback for a successful turn with %s",
    async (_name, response) => {
      const ledger = namespace();
      const turn = mock(async () => response());
      const sentTexts: string[] = [];
      globalThis.fetch = mock(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          text?: string;
        };
        if (body.text) sentTexts.push(body.text);
        return Response.json({
          ok: true,
          result: body.text ? { message_id: 9005 } : true,
        });
      }) as unknown as typeof fetch;

      expect((await run(ledger, turn, telegramRequest(81616))).status).toBe(
        200,
      );
      expect((await run(ledger, turn, telegramRequest(81616))).status).toBe(
        200,
      );
      expect(turn).toHaveBeenCalledTimes(1);
      expect(sentTexts).toEqual([PERSONAL_SHARED_FAILURE_REPLY]);
    },
  );

  test("delivers one fallback when a voice note cannot be resolved before the turn", async () => {
    const ledger = namespace();
    const turn = mock(async () =>
      Response.json({ data: { reply: "must not run" } }),
    );
    const sentTexts: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (url.endsWith("/getFile")) {
        return Response.json({ ok: false, error_code: 404 });
      }
      if (body.text) sentTexts.push(body.text);
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9006 } : true,
      });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramVoiceRequest())).status).toBe(200);
    expect((await run(ledger, turn, telegramVoiceRequest())).status).toBe(200);
    expect(turn).not.toHaveBeenCalled();
    expect(sentTexts).toEqual([PERSONAL_SHARED_FAILURE_REPLY]);
  });

  test("refuses replay after an ambiguous Telegram provider failure", async () => {
    const ledger = namespace();
    const turn = mock(async () =>
      Response.json({ data: { reply: "one reply only" } }),
    );
    globalThis.fetch = mock(async (input) => {
      if (String(input).endsWith("/sendMessage")) {
        throw new Error("response lost after provider accepted");
      }
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramRequest(81603))).status).toBe(500);
    expect((await run(ledger, turn, telegramRequest(81603))).status).toBe(503);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  test("rejects an invalid provider secret before allocating delivery state", async () => {
    const ledger = namespace();
    const turn = mock(async () => Response.json({ data: { reply: "no" } }));
    const request = telegramRequest(81604);
    request.headers.set("X-Telegram-Bot-Api-Secret-Token", "wrong");

    expect((await run(ledger, turn, request)).status).toBe(401);
    expect(turn).not.toHaveBeenCalled();
    expect(ledger.values.size).toBe(0);
  });

  test("rejects wrong bot ids and usernames before ledger, typing, or turn work", async () => {
    for (const mismatch of [{ id: 456 }, { username: "WrongTestBot" }]) {
      const ledger = namespace();
      const turn = mock(async () =>
        Response.json({ data: { reply: "must not run" } }),
      );
      const egress = globalThis.fetch;

      const response = await run(
        ledger,
        turn,
        telegramRequest(81640),
        undefined,
        "123:test-token",
        mismatch,
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "telegram_identity_not_ready",
        reason: "identity_mismatch",
      });
      expect(turn).not.toHaveBeenCalled();
      expect(ledger.names).toHaveLength(0);
      expect(egress).not.toHaveBeenCalled();
    }
  });

  test("publishes value-free Worker identity readiness", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    const env = telegramBindings() as AppEnv["Bindings"];
    const url =
      "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/readiness";

    const ready = await app.fetch(new Request(url), env, executionContext());
    expect(ready.status).toBe(200);
    expect((await ready.json()) as Record<string, unknown>).toEqual({
      project: "eliza-app",
      status: "attested",
    });

    __resetTelegramIdentityAttestationCacheForTests();
    globalThis.fetch = mock(async (input) =>
      telegramGetMeResponse(input, { username: "WrongTestBot" }),
    ) as unknown as typeof fetch;
    const notReady = await app.fetch(new Request(url), env, executionContext());
    expect(notReady.status).toBe(503);
    const body = JSON.stringify(await notReady.json());
    expect(body).toContain("identity_mismatch");
    expect(body).not.toContain("test-token");
    expect(body).not.toContain("ElizaTestBot");
  });

  test("confirms LINK codes through the canonical account route instead of model chat", async () => {
    const ledger = namespace();
    const turn = mock(async () => Response.json({ data: { reply: "wrong" } }));
    const confirm = mock(async () =>
      Response.json({ success: true, data: { status: "linked" } }),
    );
    let deliveredText = "";
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text) deliveredText = body.text;
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9003 } : true,
      });
    }) as unknown as typeof fetch;

    const response = await run(
      ledger,
      turn,
      telegramRequest(81606, "LINK-7KQ2M4XW"),
      confirm,
    );

    expect(response.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith(
      {
        code: "LINK-7KQ2M4XW",
        platform: "telegram",
        platformId: "123456",
        platformName: "Nubs",
      },
      TRACE_ID,
      expect.anything(),
      expect.anything(),
    );
    expect(turn).not.toHaveBeenCalled();
    expect(deliveredText).toContain("You're linked!");
  });

  test("keeps suffixed Dedicated Telegram webhooks on the Railway gateway", async () => {
    let forwardedUrl = "";
    globalThis.fetch = mock(async (input) => {
      forwardedUrl = String(input);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("traceId", TRACE_ID);
      await next();
    });
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    const request = telegramRequest(81605);
    const suffixedRequest = new Request(
      "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/agent-123",
      request,
    );
    const response = await app.fetch(
      suffixedRequest,
      {
        ENVIRONMENT: "staging",
        PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "false",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED: "true",
        ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
        ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.example.test",
        ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
      } as AppEnv["Bindings"],
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(forwardedUrl).toBe(
      "https://gateway.example.test/webhook/eliza-app/telegram/agent-123",
    );
  });

  test("keeps explicitly enabled epoch 1 reconciliation on its quarantined legacy namespace", async () => {
    const ledger = namespace();
    const app = new Hono<AppEnv>();
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    const request = () =>
      new Request(
        "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/delivery",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Eliza-Webhook-Forwarder-Secret": "gateway-secret",
          },
          body: JSON.stringify({
            project: "eliza-app",
            senderId: "123456",
            messageId: "81607",
            operation: "mark_uncertain",
          }),
        },
      );
    const env = {
      ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-secret",
      ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
      ...telegramBindings(),
      PERSONAL_TELEGRAM_DELIVERY_EPOCH1_COMPAT_ENABLED: "true",
      PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
    } as AppEnv["Bindings"];

    expect((await app.fetch(request(), env, executionContext())).status).toBe(
      200,
    );
    expect((await app.fetch(request(), env, executionContext())).status).toBe(
      200,
    );
    expect(new Set(ledger.names)).toEqual(
      new Set(["telegram:eliza-app:personal-shared:123456"]),
    );
    expect(
      ledger.values.get("telegram:eliza-app:personal-shared:123456:81607")
        ?.delivery,
    ).toBe("uncertain");
    const unauthorized = request();
    unauthorized.headers.set("X-Eliza-Webhook-Forwarder-Secret", "wrong");
    expect(
      (await app.fetch(unauthorized, env, executionContext())).status,
    ).toBe(401);
  });

  test("rejects epoch 1 reconciliation unless the temporary compatibility gate is exact true", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    for (const legacyGate of [undefined, "false", "1", " true "]) {
      const ledger = namespace();
      const response = await app.fetch(
        new Request(
          "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/delivery",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Eliza-Webhook-Forwarder-Secret": "gateway-secret",
            },
            body: JSON.stringify({
              project: "eliza-app",
              senderId: "123456",
              messageId: "81607",
              operation: "mark_uncertain",
            }),
          },
        ),
        {
          ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-secret",
          ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
          ...telegramBindings(),
          ...(legacyGate === undefined
            ? {}
            : {
                PERSONAL_TELEGRAM_DELIVERY_EPOCH1_COMPAT_ENABLED: legacyGate,
              }),
          PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
        } as AppEnv["Bindings"],
        executionContext(),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "LEGACY_DELIVERY_EPOCH_DISABLED",
      });
      expect(ledger.names).toHaveLength(0);
    }
  });

  test("validates epoch 2 reconciliation and writes its account-scoped boundary", async () => {
    const ledger = namespace();
    const app = new Hono<AppEnv>();
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    const request = (
      connectorAccountId: string,
      deliveryEpoch: number,
      messageId = "81613",
    ) =>
      new Request(
        "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/delivery",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Eliza-Webhook-Forwarder-Secret": "gateway-secret",
          },
          body: JSON.stringify({
            deliveryEpoch,
            project: "eliza-app",
            connectorAccountId,
            senderId: "123456",
            messageId,
            operation: "mark_delivered",
          }),
        },
      );
    const env = {
      ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-secret",
      ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
      ...telegramBindings(),
      PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
    } as AppEnv["Bindings"];

    expect(
      (await app.fetch(request("bot:123", 2), env, executionContext())).status,
    ).toBe(200);
    expect(new Set(ledger.names)).toEqual(
      new Set(["telegram:eliza-app:personal-shared:bot:123:123456"]),
    );
    expect(
      ledger.values.get(
        "telegram:eliza-app:personal-shared:bot:123:123456:telegram:eliza-app:bot:123:81613",
      )?.delivery,
    ).toBe("delivered");
    const allocatedNames = ledger.names.length;
    expect(
      (await app.fetch(request("bot:456", 2), env, executionContext())).status,
    ).toBe(403);
    expect(ledger.names).toHaveLength(allocatedNames);

    expect(
      (
        await app.fetch(
          request("bot:123", 2, "x".repeat(160)),
          env,
          executionContext(),
        )
      ).status,
    ).toBe(200);
    const scopedName = "telegram:eliza-app:personal-shared:bot:123:123456";
    const hashedKey = Array.from(ledger.values.keys()).find((key) =>
      key.startsWith(`${scopedName}:telegram:v2:bot:123:`),
    );
    expect(hashedKey).toBeDefined();
    expect(hashedKey?.slice(scopedName.length + 1).length).toBeLessThanOrEqual(
      160,
    );
    const allocatedNamesAfterValidRequests = ledger.names.length;

    expect(
      (
        await app.fetch(
          request("bot:not-a-valid-account", 2),
          env,
          executionContext(),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.fetch(request("bot:456", 1), env, executionContext())).status,
    ).toBe(400);
    expect(ledger.names).toHaveLength(allocatedNamesAfterValidRequests);

    const wrongProjectRequest = request("bot:123", 2);
    const wrongProjectBody = (await wrongProjectRequest.json()) as Record<
      string,
      unknown
    >;
    const wrongProjectResponse = await app.fetch(
      new Request(wrongProjectRequest.url, {
        method: "POST",
        headers: wrongProjectRequest.headers,
        body: JSON.stringify({ ...wrongProjectBody, project: "other-project" }),
      }),
      env,
      executionContext(),
    );
    expect(wrongProjectResponse.status).toBe(403);
    expect(ledger.names).toHaveLength(allocatedNamesAfterValidRequests);

    const unsupportedOperationRequest = request("bot:123", 2);
    const unsupportedOperationBody =
      (await unsupportedOperationRequest.json()) as Record<string, unknown>;
    const unsupportedOperationResponse = await app.fetch(
      new Request(unsupportedOperationRequest.url, {
        method: "POST",
        headers: unsupportedOperationRequest.headers,
        body: JSON.stringify({
          ...unsupportedOperationBody,
          operation: "prepare_plan",
          chunkDigests: ["a".repeat(64)],
        }),
      }),
      env,
      executionContext(),
    );
    expect(unsupportedOperationResponse.status).toBe(400);
    expect(ledger.names).toHaveLength(allocatedNamesAfterValidRequests);
  });

  test("requires Worker-side Telegram scope configuration before delivery reconciliation", async () => {
    const ledger = namespace();
    const app = new Hono<AppEnv>();
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    const response = await app.fetch(
      new Request(
        "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/delivery",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Eliza-Webhook-Forwarder-Secret": "gateway-secret",
          },
          body: JSON.stringify({
            deliveryEpoch: 2,
            project: "eliza-app",
            connectorAccountId: "bot:123",
            senderId: "123456",
            messageId: "81614",
            operation: "mark_delivered",
          }),
        },
      ),
      {
        ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-secret",
        ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
        PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
      } as AppEnv["Bindings"],
      executionContext(),
    );

    expect(response.status).toBe(503);
    expect(ledger.names).toHaveLength(0);
  });

  test("accepts the gateway edge handoff while public cutover is false and rechecks provider auth", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    const inbound = telegramRequest(81608);
    const request = new Request(
      "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/edge",
      inbound,
    );
    request.headers.set("X-Eliza-Webhook-Forwarder-Secret", "gateway-secret");
    request.headers.set("X-Eliza-Connector-Account-Id", "bot:123");
    request.headers.set("X-Telegram-Bot-Api-Secret-Token", "wrong-provider");

    const response = await app.fetch(
      request,
      {
        PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "false",
        ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-secret",
        ...telegramBindings(),
      } as AppEnv["Bindings"],
      executionContext(),
    );

    expect(response.status).toBe(401);
  });

  test("allows a headerless old gateway only while the exact legacy rollout gate is enabled", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    const request = new Request(
      "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/edge",
      telegramRequest(81616),
    );
    request.headers.set("X-Eliza-Webhook-Forwarder-Secret", "gateway-secret");
    request.headers.set("X-Telegram-Bot-Api-Secret-Token", "wrong-provider");

    const response = await app.fetch(
      request,
      {
        PERSONAL_TELEGRAM_DELIVERY_EPOCH1_COMPAT_ENABLED: "true",
        ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-secret",
        ...telegramBindings(),
      } as AppEnv["Bindings"],
      executionContext(),
    );

    // The compatibility gate bypasses only the absent account header. Provider
    // authentication remains mandatory and is rechecked by the Worker.
    expect(response.status).toBe(401);
  });

  test("rejects a gateway edge handoff whose bot account is absent or mismatched before delivery state", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/eliza-app/webhook/telegram", telegramRoute);
    for (const { accountId, legacyCompat } of [
      { accountId: undefined, legacyCompat: undefined },
      { accountId: "bot:not-valid", legacyCompat: undefined },
      { accountId: "bot:456", legacyCompat: undefined },
      { accountId: "bot:456", legacyCompat: "true" },
    ]) {
      const ledger = namespace();
      const request = new Request(
        "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/edge",
        telegramRequest(81615),
      );
      request.headers.set("X-Eliza-Webhook-Forwarder-Secret", "gateway-secret");
      if (accountId) {
        request.headers.set("X-Eliza-Connector-Account-Id", accountId);
      }
      const response = await app.fetch(
        request,
        {
          PERSONAL_TELEGRAM_DELIVERY_EPOCH1_COMPAT_ENABLED: legacyCompat,
          ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-secret",
          ...telegramBindings("123:rotated-secret"),
          PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
        } as AppEnv["Bindings"],
        executionContext(),
      );

      expect(response.status).toBe(409);
      expect(response.headers.get("X-Eliza-Failure-Stage")).toBe(
        "connector_account",
      );
      expect(ledger.names).toHaveLength(0);
    }
  });
});
