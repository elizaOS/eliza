/** Verifies Shared cron discovery, canonical claim delegation, and authenticated gateway dispatch. */

import { afterEach, describe, expect, mock, test } from "bun:test";

const listDueScheduledTaskRefs = mock(async () => [
  {
    agentId: "personal:00000000-0000-5000-8000-000000000000",
    taskId: "reminder-1",
  },
]);
const listRecoverableScheduledTaskRefs = mock(async () => []);
const claims = new Set<string>();
const coordinateSharedPushDispatch = mock(async () => {});
const createSharedScheduledTaskRunner = mock(
  (
    agentId: string,
    dispatcher: {
      dispatch(record: Record<string, unknown>): Promise<{
        ok: boolean;
        acceptance?: "unknown" | "not_accepted";
      }>;
    },
  ) => ({
    async fireWithResult(taskId: string) {
      const claim = `${agentId}:${taskId}`;
      if (claims.has(claim)) return { kind: "raced" as const };
      claims.add(claim);
      const result = await dispatcher.dispatch({
        taskId,
        promptInstructions: "stand up and stretch",
        firedAtIso: "2026-08-14T20:00:00.000Z",
        metadata: {
          dispatchIdempotencyKey: "reminder-1:2026-08-14T20:00:00.000Z",
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            chatId: "123456789",
          },
        },
        output: { fallback: { body: "time to stand up and stretch" } },
      });
      if (result.ok) return { kind: "fired" as const };
      return result.acceptance === "unknown"
        ? { kind: "dispatch_failed" as const }
        : { kind: "dispatch_deferred" as const };
    },
  }),
);

const { sharedGroupReminderMessageText } = await import("@elizaos/plugin-scheduling/edge");

mock.module("@elizaos/plugin-scheduling/edge", () => ({
  listDueScheduledTaskRefs,
  listRecoverableScheduledTaskRefs,
  SHARED_REMINDER_MAX_TEXT_LENGTH: 2000,
  sharedGroupReminderMessageText,
  parseSharedReminderDelivery(value: unknown) {
    if (!value || typeof value !== "object") return undefined;
    const delivery = value as Record<string, unknown>;
    if (delivery.platform === "telegram") return delivery;
    if (delivery.platform === "blooio") return delivery;
    if (delivery.platform === "discord") return delivery;
    return undefined;
  },
  isSharedGroupReminderDelivery(delivery: Record<string, unknown>) {
    return delivery.kind === "group";
  },
}));
mock.module("./shared-scheduling", () => ({
  createSharedScheduledTaskRunner,
  executeSharedSchedulingSql: mock(async () => []),
}));
mock.module("./conversation-coordinator", () => ({
  coordinateSharedPushDispatch,
}));

const { processDueSharedReminders, sharedReminderDispatcher } = await import(
  "./shared-reminder-cron"
);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  claims.clear();
  listDueScheduledTaskRefs.mockClear();
  listRecoverableScheduledTaskRefs.mockClear();
  createSharedScheduledTaskRunner.mockClear();
  coordinateSharedPushDispatch.mockClear();
  mock.restore();
});

const env = {
  ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.example/",
  ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL: "https://gateway-discord.example/",
  GATEWAY_INTERNAL_SECRET: "internal-secret",
  SHARED_RUNTIME_CONVERSATIONS: { getByName: mock() },
} as never;

describe("Shared reminder cron", () => {
  test("two concurrent sweeps delegate one delivery to the runner CAS", async () => {
    const requests: Request[] = [];
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = (await request.clone().json()) as Record<string, unknown>;
      return Response.json({
        success: true,
        idempotencyKey: body.idempotencyKey,
        acceptedAt: "2026-08-14T20:00:00.100Z",
        providerMessageIds: ["provider-message-1"],
      });
    }) as typeof fetch;

    const results = await Promise.all([
      processDueSharedReminders(env, {
        now: new Date("2026-08-14T20:00:00.000Z"),
      }),
      processDueSharedReminders(env, {
        now: new Date("2026-08-14T20:00:00.000Z"),
      }),
    ]);

    expect(results).toEqual([
      { scanned: 1, fired: 1, raced: 0, deferred: 0, failed: 0 },
      { scanned: 1, fired: 0, raced: 1, deferred: 0, failed: 0 },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gateway.example/internal/deliver");
    expect(requests[0]?.headers.get("X-Internal-Secret")).toBe("internal-secret");
    await expect(requests[0]?.json()).resolves.toEqual({
      platform: "telegram",
      project: "eliza-app",
      chatId: "123456789",
      text: "time to stand up and stretch",
      idempotencyKey: "reminder-1:2026-08-14T20:00:00.000Z",
    });
    expect(coordinateSharedPushDispatch).toHaveBeenCalledWith(
      "personal:00000000-0000-5000-8000-000000000000",
      {
        title: "Reminder",
        body: "time to stand up and stretch",
        collapseKey: "reminder-1:2026-08-14T20:00:00.000Z",
        data: {
          notificationId: "reminder-1:2026-08-14T20:00:00.000Z",
          category: "reminder",
          deepLink: "/chat",
          taskId: "reminder-1",
          firedAtIso: "2026-08-14T20:00:00.000Z",
        },
      },
      { namespace: env.SHARED_RUNTIME_CONVERSATIONS },
    );
  });

  test("uses edge-owned Telegram delivery with a durable provider receipt", async () => {
    const telegramDispatch = mock(async () => ({
      ok: true as const,
      acceptedAt: "2026-08-20T19:30:00.100Z",
      providerMessageIds: ["9010"],
    }));
    globalThis.fetch = mock(async () => {
      throw new Error("Railway egress must not run");
    }) as typeof fetch;
    const dispatcher = sharedReminderDispatcher(
      {
        SHARED_RUNTIME_CONVERSATIONS: env.SHARED_RUNTIME_CONVERSATIONS,
      } as never,
      "personal:00000000-0000-5000-8000-000000000000",
      { telegramDispatch },
    );

    const result = await dispatcher.dispatch({
      taskId: "edge-reminder",
      promptInstructions: "time to stretch",
      firedAtIso: "2026-08-20T19:30:00.000Z",
      metadata: {
        dispatchIdempotencyKey: "edge-reminder:2026-08-20T19:30:00.000Z",
        delivery: {
          platform: "telegram",
          project: "eliza-app",
          chatId: "123456789",
        },
      },
    });

    expect(telegramDispatch).toHaveBeenCalledWith({
      project: "eliza-app",
      chatId: "123456789",
      text: "time to stretch",
      idempotencyKey: "edge-reminder:2026-08-20T19:30:00.000Z",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      metadata: { providerMessageIds: ["9010"] },
    });
  });

  test("fails closed before egress when trusted delivery metadata is absent", async () => {
    createSharedScheduledTaskRunner.mockImplementationOnce((_agentId, dispatcher) => ({
      async fireWithResult() {
        await dispatcher.dispatch({
          taskId: "reminder-1",
          promptInstructions: "stand up",
          firedAtIso: "2026-08-14T20:00:00.000Z",
          metadata: {},
        });
        return { kind: "fired" as const };
      },
    }));
    globalThis.fetch = mock(async () => {
      throw new Error("egress must not run");
    }) as typeof fetch;

    await expect(processDueSharedReminders(env)).rejects.toThrow(
      "Shared reminder delivery metadata is invalid",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("routes Discord and Blooio through their provider-owned destinations", async () => {
    const requests: Request[] = [];
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = (await request.clone().json()) as Record<string, unknown>;
      return Response.json({
        success: true,
        idempotencyKey: body.idempotencyKey,
        acceptedAt: "2026-08-15T20:00:00.100Z",
        providerMessageIds: [`provider-${requests.length}`],
      });
    }) as typeof fetch;
    const dispatcher = sharedReminderDispatcher(env);

    const discord = await dispatcher.dispatch({
      taskId: "discord-reminder",
      promptInstructions: "check Discord",
      firedAtIso: "2026-08-15T20:00:00.000Z",
      metadata: {
        dispatchIdempotencyKey: "discord-reminder:2026-08-15T20:00:00.000Z",
        delivery: {
          platform: "discord",
          discordUserId: "123456789012345678",
        },
      },
    });
    const blooio = await dispatcher.dispatch({
      taskId: "imessage-reminder",
      promptInstructions: "check Messages",
      firedAtIso: "2026-08-15T20:01:00.000Z",
      metadata: {
        dispatchIdempotencyKey: "imessage-reminder:2026-08-15T20:01:00.000Z",
        delivery: {
          platform: "blooio",
          project: "eliza-app",
          phoneNumber: "+15551234567",
        },
      },
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://gateway-discord.example/internal/deliver",
      "https://gateway.example/internal/deliver",
    ]);
    await expect(requests[0]?.json()).resolves.toEqual({
      platform: "discord",
      discordUserId: "123456789012345678",
      text: "check Discord",
      idempotencyKey: "discord-reminder:2026-08-15T20:00:00.000Z",
    });
    await expect(requests[1]?.json()).resolves.toEqual({
      platform: "blooio",
      project: "eliza-app",
      phoneNumber: "+15551234567",
      text: "check Messages",
      idempotencyKey: "imessage-reminder:2026-08-15T20:01:00.000Z",
    });
    expect(discord).toMatchObject({
      ok: true,
      target: "123456789012345678",
    });
    expect(blooio).toMatchObject({ ok: true, target: "+15551234567" });
  });

  test("reuses the persisted occurrence key across recovery and rejects oversized text", async () => {
    const requests: Request[] = [];
    globalThis.fetch = mock(async (input, init) => {
      const outgoing = new Request(input, init);
      requests.push(outgoing);
      const body = (await outgoing.clone().json()) as Record<string, unknown>;
      return Response.json({
        success: true,
        idempotencyKey: body.idempotencyKey,
        acceptedAt: "2026-08-15T20:05:00.000Z",
        providerMessageIds: ["provider-recovered"],
      });
    }) as typeof fetch;
    const dispatcher = sharedReminderDispatcher(
      env,
      "personal:00000000-0000-5000-8000-000000000000",
    );
    const recoveredRecord = {
      taskId: "recovered-reminder",
      promptInstructions: "recover me",
      firedAtIso: "2026-08-15T20:05:00.000Z",
      metadata: {
        dispatchIdempotencyKey: "recovered-reminder:2026-08-15T20:00:00.000Z",
        delivery: {
          platform: "telegram",
          project: "eliza-app",
          chatId: "123456789",
        },
      },
    };
    await expect(dispatcher.dispatch(recoveredRecord)).resolves.toMatchObject({
      ok: true,
    });
    await expect(dispatcher.dispatch(recoveredRecord)).resolves.toMatchObject({
      ok: true,
    });
    await expect(requests[0]?.json()).resolves.toMatchObject({
      idempotencyKey: "recovered-reminder:2026-08-15T20:00:00.000Z",
    });
    expect(coordinateSharedPushDispatch).toHaveBeenCalledTimes(2);
    expect(coordinateSharedPushDispatch.mock.calls[0]?.[1]).toMatchObject({
      collapseKey: "recovered-reminder:2026-08-15T20:00:00.000Z",
    });
    expect(coordinateSharedPushDispatch.mock.calls[1]?.[1]).toMatchObject({
      collapseKey: "recovered-reminder:2026-08-15T20:00:00.000Z",
    });

    await expect(
      dispatcher.dispatch({
        taskId: "oversized-reminder",
        promptInstructions: "x".repeat(2001),
        firedAtIso: "2026-08-15T20:05:00.000Z",
        metadata: {
          dispatchIdempotencyKey: "oversized-reminder:occurrence",
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            chatId: "123456789",
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      acceptance: "not_accepted",
      userActionable: true,
    });
    expect(requests).toHaveLength(2);
  });

  for (const status of [403, 429]) {
    test(`does not record a reminder fired after an explicit ${status} rejection`, async () => {
      globalThis.fetch = mock(async () =>
        Response.json(
          {
            success: false,
            acceptance: "not_accepted",
            retryable: true,
          },
          { status },
        ),
      ) as typeof fetch;

      await expect(processDueSharedReminders(env)).resolves.toEqual({
        scanned: 1,
        fired: 0,
        raced: 0,
        deferred: 1,
        failed: 0,
      });
    });
  }

  test("does not record an indeterminate provider receipt as fired", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          success: false,
          acceptance: "unknown",
          acceptanceUnknown: true,
          retryable: false,
        },
        { status: 202 },
      ),
    ) as typeof fetch;

    await expect(processDueSharedReminders(env)).resolves.toEqual({
      scanned: 1,
      fired: 0,
      raced: 0,
      deferred: 0,
      failed: 1,
    });
  });

  for (const payload of [
    {},
    { success: true },
    {
      success: true,
      idempotencyKey: "wrong-occurrence",
      acceptedAt: "2026-08-14T20:00:00.100Z",
      providerMessageIds: ["provider-message-1"],
    },
    {
      success: true,
      idempotencyKey: "reminder-1:2026-08-14T20:00:00.000Z",
      acceptedAt: "not-a-date",
      providerMessageIds: ["provider-message-1"],
    },
    {
      success: true,
      idempotencyKey: "reminder-1:2026-08-14T20:00:00.000Z",
      acceptedAt: "2026-08-14T20:00:00.100Z",
      providerMessageIds: [],
    },
  ]) {
    test("does not fire from an unverified 2xx connector response", async () => {
      globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch;

      await expect(processDueSharedReminders(env)).resolves.toEqual({
        scanned: 1,
        fired: 0,
        raced: 0,
        deferred: 0,
        failed: 1,
      });
    });
  }

  test("preserves explicit pre-provider rejection on a 503 response", async () => {
    const dispatcher = sharedReminderDispatcher(env);
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          success: false,
          acceptance: "not_accepted",
          retryable: true,
        },
        { status: 503 },
      ),
    ) as typeof fetch;

    await expect(
      dispatcher.dispatch({
        taskId: "reminder-1",
        promptInstructions: "stand up",
        firedAtIso: "2026-08-14T20:00:00.000Z",
        metadata: {
          dispatchIdempotencyKey: "reminder-1:2026-08-14T20:00:00.000Z",
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            chatId: "123456789",
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 1,
      acceptance: "not_accepted",
    });
  });
});
