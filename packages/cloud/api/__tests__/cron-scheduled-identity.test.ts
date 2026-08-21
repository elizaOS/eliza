/**
 * Pins the deterministic scheduled-event identity propagated by the real
 * Cloudflare cron dispatcher. A retried tick must reach each route with the
 * same identity, while sibling fanout routes must never share one.
 */

import { describe, expect, test } from "bun:test";
import {
  CRON_FANOUT,
  cloneRequestWithScheduledCronMetadata,
  getScheduledCronInvocationMetadata,
  makeCronHandler,
  scheduledCronInvocationId,
} from "@/lib/cron/cloudflare-cron";
import type { Bindings } from "@/types/cloud-worker-env";

const SCHEDULE = "*/5 * * * *";
const SCHEDULED_TIME = Date.UTC(2026, 7, 20, 17, 30, 0);

async function dispatch(scheduledTime: number): Promise<Request[]> {
  const requests: Request[] = [];
  const pending: Promise<unknown>[] = [];
  const handler = makeCronHandler(async (request) => {
    requests.push(request);
    return new Response(null, { status: 204 });
  });
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
  };

  await handler(
    { cron: SCHEDULE, scheduledTime },
    {
      CRON_SECRET: "cron-secret",
      NEXT_PUBLIC_APP_URL: "https://internal.example.test",
    } as Bindings,
    context as never,
  );
  await Promise.all(pending);
  return requests;
}

describe("Cloudflare cron scheduled identity", () => {
  test("is stable across retry and unique for every fanout path", async () => {
    const first = await dispatch(SCHEDULED_TIME);
    const retry = await dispatch(SCHEDULED_TIME);
    const paths = CRON_FANOUT[SCHEDULE] ?? [];

    expect(first).toHaveLength(paths.length);
    expect(retry).toHaveLength(paths.length);

    const identities = first.map((request) =>
      request.headers.get("x-cron-invocation-id"),
    );
    expect(new Set(identities).size).toBe(paths.length);
    expect(identities.sort()).toEqual(
      retry
        .map((request) => request.headers.get("x-cron-invocation-id"))
        .sort(),
    );

    for (const request of first) {
      const path = new URL(request.url).pathname;
      const expectedMetadata = {
        invocationId: scheduledCronInvocationId(
          { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
          path,
        ),
        path,
        schedule: SCHEDULE,
        scheduledTime: SCHEDULED_TIME,
      };
      expect(getScheduledCronInvocationMetadata(request)).toEqual(
        expectedMetadata,
      );
      expect(
        getScheduledCronInvocationMetadata(
          cloneRequestWithScheduledCronMetadata(request, {
            headers: new Headers(request.headers),
          }),
        ),
      ).toEqual(expectedMetadata);
      expect(request.method).toBe("POST");
      expect(request.headers.get("x-cron-schedule")).toBe(SCHEDULE);
      expect(request.headers.get("x-cron-scheduled-time")).toBe(
        String(SCHEDULED_TIME),
      );
      expect(request.headers.get("x-cron-invocation-id")).toBe(
        scheduledCronInvocationId(
          { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
          path,
        ),
      );
    }
  });

  test("changes when Cloudflare advances the scheduled time", async () => {
    const first = await dispatch(SCHEDULED_TIME);
    const next = await dispatch(SCHEDULED_TIME + 5 * 60_000);

    expect(
      new Set(
        first.map((request) => request.headers.get("x-cron-invocation-id")),
      ),
    ).not.toEqual(
      new Set(
        next.map((request) => request.headers.get("x-cron-invocation-id")),
      ),
    );
  });

  test("never brands an external request with exact scheduler headers", () => {
    const path = "/api/cron/agent-billing";
    const invocationId = scheduledCronInvocationId(
      { cron: "0 * * * *", scheduledTime: SCHEDULED_TIME },
      path,
    );
    const external = new Request(`https://internal.example.test${path}`, {
      headers: {
        "x-cron-invocation-id": invocationId,
        "x-cron-schedule": "0 * * * *",
        "x-cron-scheduled-time": String(SCHEDULED_TIME),
      },
    });

    expect(getScheduledCronInvocationMetadata(external)).toBeNull();
    expect(
      getScheduledCronInvocationMetadata(
        cloneRequestWithScheduledCronMetadata(external),
      ),
    ).toBeNull();
  });
});
