import { describe, expect, mock, test } from "bun:test";
import { executeResponseAttempts } from "./response-attempts";

describe("executeResponseAttempts", () => {
  test("keeps one fresh-auth request after transport retries consume the normal budget", async () => {
    let requestNumber = 0;
    let freshAuth = false;
    const refreshAuth = mock(async () => {
      freshAuth = true;
    });
    const observations: Array<{
      attempt: number;
      maxAttempts: number;
      retryReason: string | null;
    }> = [];

    const result = await executeResponseAttempts({
      maxAttempts: 3,
      authRefreshAttemptsOutsideBudget: 1,
      retryStatuses: true,
      retryTransport: true,
      request: async () => {
        requestNumber += 1;
        if (requestNumber <= 2) throw new Error("transient timeout");
        if (!freshAuth) return new Response("stale", { status: 401 });
        return new Response("ok", { status: 200 });
      },
      refreshAuth,
      observe: (observation) => {
        observations.push({
          attempt: observation.attempt,
          maxAttempts: observation.maxAttempts,
          retryReason: observation.retryReason,
        });
      },
    });

    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(4);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([
      { attempt: 1, maxAttempts: 4, retryReason: "transport" },
      { attempt: 2, maxAttempts: 4, retryReason: "transport" },
      { attempt: 3, maxAttempts: 4, retryReason: "auth_refresh" },
      { attempt: 4, maxAttempts: 4, retryReason: null },
    ]);
  });

  test("does not expand transport retries when no authentication refresh occurs", async () => {
    const request = mock(async () => {
      throw new Error("still unavailable");
    });

    await expect(
      executeResponseAttempts({
        maxAttempts: 3,
        authRefreshAttemptsOutsideBudget: 1,
        retryStatuses: true,
        retryTransport: true,
        request,
        refreshAuth: async () => undefined,
        observe: () => undefined,
      }),
    ).rejects.toThrow("still unavailable");
    expect(request).toHaveBeenCalledTimes(3);
  });

  test("treats only canonical decimal Retry-After as valid delay", async () => {
    const cases: Array<{
      header: string | null;
      shouldBeCanonical: boolean;
    }> = [
      { header: "5", shouldBeCanonical: true },
      { header: "0", shouldBeCanonical: true },
      { header: " 5 ", shouldBeCanonical: true },
      { header: "5.9", shouldBeCanonical: false },
      { header: "10, 20", shouldBeCanonical: false },
      { header: "0x10", shouldBeCanonical: false },
      { header: "  ", shouldBeCanonical: false },
      { header: null, shouldBeCanonical: false },
    ];

    for (const { header, shouldBeCanonical } of cases) {
      const observations: Array<{
        retryAfterSeconds: number | null;
        retryDelayMs: number | null;
      }> = [];
      let first = true;
      await executeResponseAttempts({
        maxAttempts: 2,
        retryDelayCapMs: 10,
        retryStatuses: true,
        retryTransport: false,
        request: async () => {
          if (first) {
            first = false;
            const headers = new Headers();
            if (header !== null) headers.set("Retry-After", header);
            return new Response("retry", { status: 429, headers });
          }
          return new Response("ok", { status: 200 });
        },
        observe: (observation) => {
          observations.push({
            retryAfterSeconds: observation.retryAfterSeconds,
            retryDelayMs: observation.retryDelayMs,
          });
        },
      });

      const firstObs = observations[0];
      if (shouldBeCanonical) {
        const expected = Number.parseInt((header ?? "").trim(), 10);
        expect(firstObs.retryAfterSeconds).toBe(expected);
        expect(firstObs.retryDelayMs).toBe(Math.min(expected * 1_000, 10));
      } else {
        expect(firstObs.retryAfterSeconds).toBeNull();
        expect(firstObs.retryDelayMs).toBe(200);
      }
    }
  });
});
