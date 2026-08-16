/** Drives the edge Telegram connector through Hono with real shared state-machine code. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  getRuntimeR2Bucket,
  setRuntimeR2Bucket,
} from "@/lib/storage/r2-runtime-binding";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import {
  handlePersonalTelegramEdge,
  type TelegramEdgeDeps,
} from "../eliza-app/webhook/_telegram-edge";
import telegramRoute from "../eliza-app/webhook/telegram/route";

const TRACE_ID = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;

interface LedgerValue {
  progress?: {
    state: "pending" | "egress_started" | "delivered";
    contentDigest: string;
    totalChunks: number;
    nextChunkIndex: number;
    providerMessageIds: string[];
    activeChunkIndex?: number;
  };
  ownerToken?: string;
}

type RunTurn = NonNullable<
  Parameters<typeof handlePersonalTelegramEdge>[1]
>["runTurn"];

function namespace(): {
  binding: AppEnv["Bindings"]["PERSONAL_TELEGRAM_DELIVERIES"];
  values: Map<string, LedgerValue>;
} {
  const values = new Map<string, LedgerValue>();
  return {
    values,
    binding: {
      getByName(name: string) {
        return {
          async fetch(_input: RequestInfo | URL, init?: RequestInit) {
            const body = JSON.parse(String(init?.body)) as {
              messageId: string;
              operation: string;
              ownerToken?: string;
              contentDigest?: string;
              totalChunks?: number;
              chunkIndex?: number;
              providerMessageId?: string;
            };
            const key = `${name}:${body.messageId}`;
            const value = values.get(key) ?? {};
            if (body.operation === "read") {
              return Response.json({ progress: value.progress ?? null });
            }
            if (body.operation === "claim_processing") {
              if (value.ownerToken) return Response.json({ claimed: false });
              value.ownerToken = body.ownerToken;
              values.set(key, value);
              return Response.json({ claimed: true });
            }
            if (body.operation === "renew_processing") {
              return Response.json({
                renewed: value.ownerToken === body.ownerToken,
              });
            }
            if (body.operation === "release_processing") {
              if (value.ownerToken === body.ownerToken) delete value.ownerToken;
              values.set(key, value);
              return Response.json({ released: true });
            }
            if (body.operation === "prepare_plan") {
              value.progress ??= {
                state: "pending",
                contentDigest: body.contentDigest ?? "",
                totalChunks: body.totalChunks ?? 0,
                nextChunkIndex: 0,
                providerMessageIds: [],
              };
              values.set(key, value);
              return Response.json({ progress: value.progress });
            }
            if (body.operation === "claim_chunk") {
              if (
                value.progress?.state !== "pending" ||
                value.progress.nextChunkIndex !== body.chunkIndex
              )
                return Response.json({ claimed: false });
              value.progress.state = "egress_started";
              value.progress.activeChunkIndex = body.chunkIndex;
              return Response.json({ claimed: true, progress: value.progress });
            }
            if (body.operation === "record_accepted" && value.progress) {
              value.progress.state = "pending";
              value.progress.nextChunkIndex += 1;
              value.progress.providerMessageIds.push(
                body.providerMessageId ?? "",
              );
              delete value.progress.activeChunkIndex;
              return Response.json({ progress: value.progress });
            }
            if (
              body.operation === "record_explicit_rejection" &&
              value.progress
            ) {
              value.progress.state = "pending";
              delete value.progress.activeChunkIndex;
              return Response.json({ progress: value.progress });
            }
            if (value.progress) value.progress.state = "delivered";
            values.set(key, value);
            return Response.json({ progress: value.progress });
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
  return app.fetch(
    request,
    {
      ELIZA_APP_TELEGRAM_BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA",
      ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
      PERSONAL_TELEGRAM_DELIVERIES: ledger.binding,
    } as AppEnv["Bindings"],
    executionContext(),
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeR2Bucket(null);
  mock.restore();
});

describe("Personal Shared Telegram edge", () => {
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

  test("releases the processing claim after all pre-egress attempts fail", async () => {
    const ledger = namespace();
    let available = false;
    const turn = mock(async () =>
      available
        ? Response.json({ data: { reply: "Recovered" } })
        : Response.json(
            { error: "warming" },
            { status: 503, headers: { "Retry-After": "0" } },
          ),
    );
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      return Response.json({
        ok: true,
        result: body.text ? { message_id: 9002 } : true,
      });
    }) as unknown as typeof fetch;

    expect((await run(ledger, turn, telegramRequest(81602))).status).toBe(500);
    available = true;
    expect((await run(ledger, turn, telegramRequest(81602))).status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(4);
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

    expect((await run(ledger, turn, telegramRequest(81603))).status).toBe(200);
    expect((await run(ledger, turn, telegramRequest(81603))).status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  test("rejects an invalid provider secret before allocating delivery state", async () => {
    const ledger = namespace();
    const turn = mock(async () => Response.json({ data: { reply: "no" } }));
    const request = telegramRequest(81604);
    request.headers.set("X-Telegram-Bot-Api-Secret-Token", "wrong");
    const sentinelBucket = {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    };
    setRuntimeR2Bucket(sentinelBucket);

    expect((await run(ledger, turn, request)).status).toBe(401);
    expect(turn).not.toHaveBeenCalled();
    expect(ledger.values.size).toBe(0);
    expect(getRuntimeR2Bucket()).toBe(sentinelBucket);
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
        PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "true",
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
});
