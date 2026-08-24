/**
 * Unit tests for the shared cloud QueryClient singleton.
 * Drives the real @tanstack/react-query instance: pins the dashboard's default
 * stale/gc/refetch/mutation settings, exercises the installed query-retry
 * predicate against genuine ApiError and network failures, and proves the
 * retry policy end-to-end through real fetchQuery calls.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client.ts";
import { queryClient } from "./query-client.ts";

/** The installed query retry predicate, narrowed from the live defaults. */
function queryRetry() {
  const retry = queryClient.getDefaultOptions().queries?.retry;
  if (typeof retry !== "function") {
    throw new Error("expected queries.retry default to be a function");
  }
  return retry;
}

function apiError(status: number): ApiError {
  return new ApiError(
    status,
    `HTTP_${status}`,
    `Request failed with status ${status}`,
  );
}

describe("queryClient", () => {
  it("exposes a real QueryClient instance", () => {
    expect(queryClient).toBeInstanceOf(QueryClient);
  });

  describe("default query options", () => {
    it("keeps the dashboard's read-mostly stale and gc windows", () => {
      const options = queryClient.getDefaultOptions().queries;
      expect(options?.staleTime).toBe(30_000);
      expect(options?.gcTime).toBe(5 * 60_000);
    });

    it("disables refetch-on-window-focus so navigation does not hammer the API", () => {
      expect(
        queryClient.getDefaultOptions().queries?.refetchOnWindowFocus,
      ).toBe(false);
    });
  });

  describe("default mutation options", () => {
    it("never retries mutations", () => {
      expect(queryClient.getDefaultOptions().mutations?.retry).toBe(false);
    });
  });

  describe("query retry policy", () => {
    it("never retries client (4xx) errors regardless of failure count", () => {
      const retry = queryRetry();
      for (const status of [400, 401, 403, 404, 429]) {
        expect(retry(0, apiError(status))).toBe(false);
        expect(retry(1, apiError(status))).toBe(false);
      }
    });

    it("treats exactly [400, 500) as non-retryable statuses", () => {
      const retry = queryRetry();
      expect(retry(0, apiError(399))).toBe(true);
      expect(retry(0, apiError(400))).toBe(false);
      expect(retry(0, apiError(499))).toBe(false);
      expect(retry(0, apiError(500))).toBe(true);
    });

    it("retries server (5xx) errors up to two failed attempts", () => {
      const retry = queryRetry();
      for (const status of [500, 502, 503]) {
        expect(retry(0, apiError(status))).toBe(true);
        expect(retry(1, apiError(status))).toBe(true);
        expect(retry(2, apiError(status))).toBe(false);
      }
    });

    it("retries non-HTTP (network or unknown) errors up to two failed attempts", () => {
      const retry = queryRetry();
      const network = new TypeError("fetch failed");
      expect(retry(0, network)).toBe(true);
      expect(retry(1, network)).toBe(true);
      expect(retry(2, network)).toBe(false);

      const generic = new Error("boom");
      expect(retry(0, generic)).toBe(true);
      expect(retry(2, generic)).toBe(false);
    });
  });

  describe("retry behaviour through a real fetchQuery", () => {
    afterEach(() => {
      vi.useRealTimers();
      queryClient.clear();
    });

    it("rejects a 4xx response after exactly one attempt with no retry scheduled", async () => {
      vi.useFakeTimers();
      let attempts = 0;
      // Attach the rejection handler synchronously so the failure never
      // surfaces as an unhandled rejection while timers advance.
      let rejection: unknown;
      const settled = queryClient
        .fetchQuery({
          queryKey: ["test", "query-client", "client-error-no-retry"],
          queryFn: () => {
            attempts += 1;
            return Promise.reject(apiError(404));
          },
        })
        .catch((error: unknown) => {
          rejection = error;
        });
      await settled;
      expect(attempts).toBe(1);
      expect(rejection).toBeDefined();
    });

    it("retries a network failure twice before giving up", async () => {
      vi.useFakeTimers();
      let attempts = 0;
      let rejected = false;
      const settled = queryClient
        .fetchQuery({
          queryKey: ["test", "query-client", "network-retry-exhaustion"],
          queryFn: () => {
            attempts += 1;
            return Promise.reject(new TypeError("fetch failed"));
          },
        })
        .catch(() => {
          rejected = true;
        });
      // Drive past both default backoff delays (1s, then 2s).
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
      expect(rejected).toBe(true);
      expect(attempts).toBe(3);
    });
  });
});
