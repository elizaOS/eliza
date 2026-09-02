/**
 * Deterministically exercises bounded HTTP replay, abort, disposal, and
 * diagnostic-isolation behavior without contacting a provider.
 */

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
      replayPolicy: "idempotent",
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
      reportObservationError: () => undefined,
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

  test("disposes retry responses before the next request", async () => {
    let cancelled = false;
    let calls = 0;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    );
    const result = await executeResponseAttempts({
      maxAttempts: 2,
      replayPolicy: "safe",
      retryStatuses: true,
      retryTransport: false,
      request: async () => {
        calls += 1;
        if (calls === 2) expect(cancelled).toBe(true);
        return calls === 1 ? response : new Response("ok");
      },
      sleep: async () => undefined,
      reportObservationError: () => undefined,
      observe: () => undefined,
    });
    expect(result.response.status).toBe(200);
  });

  test("spends at most one outside-budget 401 refresh", async () => {
    const refreshAuth = mock(async () => undefined);
    const request = mock(async () => new Response("stale", { status: 401 }));
    const result = await executeResponseAttempts({
      maxAttempts: 1,
      authRefreshAttemptsOutsideBudget: 1,
      replayPolicy: "idempotent",
      retryStatuses: true,
      retryTransport: true,
      request,
      refreshAuth,
      reportObservationError: () => undefined,
      observe: () => undefined,
    });
    expect(result.response.status).toBe(401);
    expect(request).toHaveBeenCalledTimes(2);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
  });

  test("never replays an unsafe POST after a response or transport failure", async () => {
    const statusRequest = mock(
      async () => new Response("busy", { status: 503 }),
    );
    const statusResult = await executeResponseAttempts({
      maxAttempts: 3,
      replayPolicy: "never",
      retryStatuses: true,
      retryTransport: true,
      request: statusRequest,
      reportObservationError: () => undefined,
      observe: () => undefined,
    });
    expect(statusResult.response.status).toBe(503);
    expect(statusRequest).toHaveBeenCalledTimes(1);

    const error = new Error("ambiguous POST outcome");
    const transportRequest = mock(async () => {
      throw error;
    });
    await expect(
      executeResponseAttempts({
        maxAttempts: 3,
        replayPolicy: "never",
        retryStatuses: true,
        retryTransport: true,
        request: transportRequest,
        reportObservationError: () => undefined,
        observe: () => undefined,
      }),
    ).rejects.toThrow("ambiguous POST outcome");
    expect(transportRequest).toHaveBeenCalledTimes(1);
  });

  test("does not expand transport retries when no authentication refresh occurs", async () => {
    const request = mock(async () => {
      throw new Error("still unavailable");
    });

    await expect(
      executeResponseAttempts({
        maxAttempts: 3,
        replayPolicy: "idempotent",
        authRefreshAttemptsOutsideBudget: 1,
        retryStatuses: true,
        retryTransport: true,
        request,
        refreshAuth: async () => undefined,
        reportObservationError: () => undefined,
        observe: () => undefined,
      }),
    ).rejects.toThrow("still unavailable");
    expect(request).toHaveBeenCalledTimes(3);
  });

  test("does not replay a terminal 500 marked non-retryable", async () => {
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
      replayPolicy: "idempotent",
      honorExplicitRetryable: true,
      retryStatuses: true,
      retryTransport: true,
      request,
      reportObservationError: () => undefined,
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
      replayPolicy: "idempotent",
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
      reportObservationError: () => undefined,
      observe: () => undefined,
    });

    expect(result.response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("keeps status retries unless explicit disposition is opted in", async () => {
    let attempts = 0;
    const result = await executeResponseAttempts({
      maxAttempts: 2,
      replayPolicy: "idempotent",
      retryStatuses: true,
      retryTransport: true,
      request: async () => {
        attempts += 1;
        return new Response("terminal for opted-in callers only", {
          status: 500,
          headers: { "X-Eliza-Retryable": "false" },
        });
      },
      reportObservationError: () => undefined,
      observe: () => undefined,
    });

    expect(result.response.status).toBe(500);
    expect(attempts).toBe(2);
  });

  test("reports observer failures without replaying a successful request", async () => {
    const request = mock(async () => new Response("ok"));
    const observerError = new Error("diagnostic sink unavailable");
    let reportedError: unknown;
    let reportCount = 0;

    const result = await executeResponseAttempts({
      maxAttempts: 3,
      replayPolicy: "safe",
      retryStatuses: true,
      retryTransport: true,
      request,
      observe: () => {
        throw observerError;
      },
      reportObservationError: (error) => {
        reportCount += 1;
        reportedError = error;
      },
    });

    expect(result.response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
    expect(reportCount).toBe(1);
    expect(reportedError).toBe(observerError);
  });

  test("keeps status replay independent from observer failures", async () => {
    let requestNumber = 0;
    const request = mock(async () => {
      requestNumber += 1;
      return requestNumber === 1
        ? new Response("busy", { status: 503 })
        : new Response("ok");
    });
    const reportObservationError = mock((_error: unknown) => undefined);

    const result = await executeResponseAttempts({
      maxAttempts: 2,
      replayPolicy: "safe",
      retryStatuses: true,
      retryTransport: true,
      request,
      sleep: async () => undefined,
      observe: () => {
        throw new Error("diagnostic sink unavailable");
      },
      reportObservationError,
    });

    expect(result.response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
    expect(reportObservationError).toHaveBeenCalledTimes(2);
  });

  test("does not classify auth refresh or backoff failures as transport", async () => {
    const request = mock(async () => new Response("stale", { status: 401 }));
    const refreshError = new Error("refresh rejected");
    await expect(
      executeResponseAttempts({
        maxAttempts: 2,
        replayPolicy: "idempotent",
        retryStatuses: true,
        retryTransport: true,
        request,
        refreshAuth: async () => {
          throw refreshError;
        },
        observe: () => undefined,
        reportObservationError: () => undefined,
      }),
    ).rejects.toBe(refreshError);
    expect(request).toHaveBeenCalledTimes(1);

    const statusRequest = mock(
      async () => new Response("busy", { status: 503 }),
    );
    const abortError = new DOMException("aborted", "AbortError");
    await expect(
      executeResponseAttempts({
        maxAttempts: 2,
        replayPolicy: "safe",
        retryStatuses: true,
        retryTransport: true,
        request: statusRequest,
        sleep: async () => {
          throw abortError;
        },
        observe: () => undefined,
        reportObservationError: () => undefined,
      }),
    ).rejects.toBe(abortError);
    expect(statusRequest).toHaveBeenCalledTimes(1);
  });
});
