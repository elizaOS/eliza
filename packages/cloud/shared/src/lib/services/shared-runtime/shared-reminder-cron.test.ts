/** Verifies Shared cron discovery, canonical claim delegation, and authenticated gateway dispatch. */

import { afterEach, describe, expect, mock, test } from "bun:test";

const listDueScheduledTaskRefs = mock(async () => [
  { agentId: "personal:owner", taskId: "reminder-1" },
]);
const claims = new Set<string>();
const createSharedScheduledTaskRunner = mock(
  (
    agentId: string,
    dispatcher: {
      dispatch(record: Record<string, unknown>): Promise<{ ok: boolean }>;
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
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            chatId: "123456789",
          },
        },
        output: { fallback: { body: "time to stand up and stretch" } },
      });
      return result.ok ? { kind: "fired" as const } : { kind: "dispatch_deferred" as const };
    },
  }),
);

mock.module("@elizaos/plugin-scheduling/edge", () => ({
  listDueScheduledTaskRefs,
}));
mock.module("./shared-scheduling", () => ({
  createSharedScheduledTaskRunner,
  executeSharedSchedulingSql: mock(async () => []),
}));

const { processDueSharedReminders } = await import("./shared-reminder-cron");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  claims.clear();
  listDueScheduledTaskRefs.mockClear();
  createSharedScheduledTaskRunner.mockClear();
  mock.restore();
});

const env = {
  ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.example/",
  GATEWAY_INTERNAL_SECRET: "internal-secret",
} as never;

describe("Shared reminder cron", () => {
  test("two concurrent sweeps delegate one delivery to the runner CAS", async () => {
    const requests: Request[] = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        success: true,
        acceptedAt: "2026-08-14T20:00:00.100Z",
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
      "Shared reminder has no trusted delivery metadata",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
      deferred: 1,
      failed: 0,
    });
  });
});
