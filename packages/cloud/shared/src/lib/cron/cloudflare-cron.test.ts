/**
 * Exercises cron fanout completion and failure reporting through the real
 * scheduled-handler adapter with deterministic in-memory route responses.
 */
import { describe, expect, test } from "bun:test";
import { makeCronHandler } from "./cloudflare-cron";

function requireScheduledWork(work: Promise<unknown> | undefined): Promise<unknown> {
  if (!work) throw new Error("scheduled handler did not register waitUntil");
  return work;
}

describe("Cloudflare cron fanout", () => {
  test("dispatches the authenticated canonical expiry route every ten minutes", async () => {
    const requests: Request[] = [];
    let work: Promise<unknown> | undefined;
    const scheduled = makeCronHandler(async (request) => {
      requests.push(request);
      return new Response(null, { status: 200 });
    });

    await scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now() },
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://api.example.test",
      } as never,
      {
        waitUntil(promise: Promise<unknown>) {
          work = promise;
        },
      } as never,
    );
    await expect(requireScheduledWork(work)).resolves.toBeUndefined();

    const expiryRequest = requests.find(
      (request) => new URL(request.url).pathname === "/api/cron/cleanup-expired-payment-requests",
    );
    expect(expiryRequest?.method).toBe("POST");
    expect(expiryRequest?.headers.get("x-cron-secret")).toBe("cron-secret");
  });

  test("waits for successful siblings before reporting a 500 failure", async () => {
    let releaseSlowRoute: (() => void) | undefined;
    const slowRouteGate = new Promise<void>((resolve) => {
      releaseSlowRoute = resolve;
    });
    const completed: string[] = [];
    let noRetryCalls = 0;
    let work: Promise<unknown> | undefined;
    const scheduled = makeCronHandler(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/cron/agent-backup-admission") {
        completed.push(path);
        return new Response(null, { status: 500 });
      }
      if (path === "/api/v1/cron/process-provisioning-jobs") {
        await slowRouteGate;
        completed.push(path);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });

    await scheduled(
      { cron: "* * * * *", scheduledTime: Date.now(), noRetry: () => noRetryCalls++ },
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://api.example.test",
      } as never,
      {
        waitUntil(promise: Promise<unknown>) {
          work = promise;
        },
      } as never,
    );

    let settled = false;
    void requireScheduledWork(work).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Bun.sleep(1);
    expect(settled).toBe(false);
    expect(completed).toEqual(["/api/v1/cron/agent-backup-admission"]);

    if (!releaseSlowRoute) throw new Error("slow route was not started");
    releaseSlowRoute();

    await expect(requireScheduledWork(work)).rejects.toThrow(
      "[Cron] /api/v1/cron/agent-backup-admission -> 500",
    );
    expect(completed).toEqual([
      "/api/v1/cron/agent-backup-admission",
      "/api/v1/cron/process-provisioning-jobs",
    ]);
    expect(noRetryCalls).toBe(1);
  });

  test("preserves best-effort completion for legacy thrown and 5xx routes", async () => {
    let work: Promise<unknown> | undefined;
    let noRetryCalls = 0;
    const scheduled = makeCronHandler(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/cron/agent-billing") {
        throw new Error("billing database unavailable");
      }
      if (path === "/api/cron/process-account-deletions") {
        return new Response(null, { status: 503 });
      }
      throw new Error(`unexpected cron path: ${path}`);
    });

    await scheduled(
      { cron: "0 * * * *", scheduledTime: Date.now(), noRetry: () => noRetryCalls++ },
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://api.example.test",
      } as never,
      {
        waitUntil(promise: Promise<unknown>) {
          work = promise;
        },
      } as never,
    );

    await expect(requireScheduledWork(work)).resolves.toBeUndefined();
    expect(noRetryCalls).toBe(0);
  });

  test("reports every non-2xx response from the opted-in admission caller", async () => {
    let work: Promise<unknown> | undefined;
    let noRetryCalls = 0;
    const scheduled = makeCronHandler(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/cron/agent-backup-admission") {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204 });
    });

    await scheduled(
      { cron: "* * * * *", scheduledTime: Date.now(), noRetry: () => noRetryCalls++ },
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://api.example.test",
      } as never,
      {
        waitUntil(promise: Promise<unknown>) {
          work = promise;
        },
      } as never,
    );

    await expect(requireScheduledWork(work)).rejects.toThrow(
      "[Cron] /api/v1/cron/agent-backup-admission -> 403",
    );
    expect(noRetryCalls).toBe(1);
  });

  test("reports an opted-in throw without replaying the shared fanout", async () => {
    let work: Promise<unknown> | undefined;
    let noRetryCalls = 0;
    const scheduled = makeCronHandler(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/cron/agent-backup-admission") {
        throw new Error("admission database unavailable");
      }
      return new Response(null, { status: 204 });
    });

    await scheduled(
      { cron: "* * * * *", scheduledTime: Date.now(), noRetry: () => noRetryCalls++ },
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://api.example.test",
      } as never,
      {
        waitUntil(promise: Promise<unknown>) {
          work = promise;
        },
      } as never,
    );

    await expect(requireScheduledWork(work)).rejects.toThrow(
      "[Cron] /api/v1/cron/agent-backup-admission threw",
    );
    expect(noRetryCalls).toBe(1);
  });
});
