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
});
