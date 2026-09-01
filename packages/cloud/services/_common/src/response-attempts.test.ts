/** Verifies bounded response retries honor explicit upstream disposition. */
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

  test("does not replay a terminal 500 when the upstream marks it non-retryable", async () => {
    const request = mock(
      async () =>
        new Response("terminal", {
          status: 500,
          headers: { "X-Eliza-Retryable": "false" },
        }),
    );
    const observations: boolean[] = [];

    const result = await executeResponseAttempts({
      maxAttempts: 3,
      honorExplicitRetryable: true,
      retryStatuses: true,
      retryTransport: true,
      request,
      observe: (observation) => {
        observations.push(observation.retryable);
      },
    });

    expect(result.response.status).toBe(500);
    expect(request).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([false]);
  });

  test("retries an explicitly recoverable non-5xx response", async () => {
    let attempts = 0;
    const result = await executeResponseAttempts({
      maxAttempts: 2,
      honorExplicitRetryable: true,
      retryStatuses: true,
      retryTransport: true,
      request: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("pending", {
              status: 409,
              headers: {
                "Retry-After": "0",
                "X-Eliza-Retryable": "true",
              },
            })
          : new Response("ok", { status: 200 });
      },
      observe: () => undefined,
    });

    expect(result.response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("keeps legacy status retries unless explicit disposition is opted in", async () => {
    let attempts = 0;
    const result = await executeResponseAttempts({
      maxAttempts: 2,
      retryStatuses: true,
      retryTransport: true,
      request: async () => {
        attempts += 1;
        return new Response("terminal for opted-in callers only", {
          status: 500,
          headers: { "X-Eliza-Retryable": "false" },
        });
      },
      observe: () => undefined,
    });

    expect(result.response.status).toBe(500);
    expect(attempts).toBe(2);
  });
});
