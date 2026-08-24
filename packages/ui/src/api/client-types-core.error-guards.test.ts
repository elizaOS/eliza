/**
 * Covers the runtime surface of client-types-core: ApiError construction and
 * property semantics plus the isApiError / isRateLimitedError /
 * isCloudAgentGoneError guards. Complements client-types-core.api-error.test.ts,
 * which pins the structured-body privacy contract.
 */
import { describe, expect, test } from "vitest";
import {
  ApiError,
  isApiError,
  isCloudAgentGoneError,
  isRateLimitedError,
} from "./client-types-core";

function wrapError(cause: unknown): Error {
  const wrapper = new Error("agent selection failed");
  (wrapper as Error & { cause?: unknown }).cause = cause;
  return wrapper;
}

describe("ApiError construction", () => {
  test("is an Error named ApiError carrying its classification fields", () => {
    const error = new ApiError({
      kind: "http",
      path: "/api/agents",
      status: 402,
      code: "insufficient_credits",
      message: "insufficient credits",
      retryAfter: 30,
    });

    expect(error instanceof Error).toBe(true);
    expect(error.name).toBe("ApiError");
    expect(error.message).toBe("insufficient credits");
    expect(error.kind).toBe("http");
    expect(error.path).toBe("/api/agents");
    expect(error.status).toBe(402);
    expect(error.code).toBe("insufficient_credits");
    expect(error.retryAfter).toBe(30);
  });

  test("stores optional fields as undefined when omitted", () => {
    const error = new ApiError({
      kind: "network",
      path: "/api/status",
      message: "connection refused",
    });

    expect(error.status).toBeUndefined();
    expect(error.code).toBeUndefined();
    expect(error.retryAfter).toBeUndefined();
    expect(error.data).toBeUndefined();
  });

  test("keeps the parsed body readable but hidden from enumeration and writes", () => {
    const body = { error: "quota_exceeded", detail: "plan limit" };
    const error = new ApiError({
      kind: "http",
      path: "/api/test",
      message: "failed",
      status: 402,
      data: body,
    });

    expect(error.data).toBe(body);
    const descriptor = Object.getOwnPropertyDescriptor(error, "data");
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(Object.keys(error)).not.toContain("data");
    expect(JSON.stringify(error)).not.toContain("plan limit");
  });

  test("wires cause through to the underlying error and leaves it unset otherwise", () => {
    const root = new Error("socket hang up");
    const wrapped = new ApiError({
      kind: "timeout",
      path: "/api/chat",
      message: "request timed out",
      cause: root,
    });
    expect(wrapped.cause).toBe(root);

    const unwrapped = new ApiError({
      kind: "parse",
      path: "/api/chat",
      message: "bad json",
    });
    expect(unwrapped.cause).toBeUndefined();
  });
});

describe("isApiError", () => {
  test("accepts ApiError instances only", () => {
    const apiError = new ApiError({
      kind: "network",
      path: "/api/x",
      message: "boom",
    });
    expect(isApiError(apiError)).toBe(true);
    expect(isApiError(new Error("plain"))).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError("timeout")).toBe(false);
    expect(isApiError({ kind: "timeout", path: "/api/x" })).toBe(false);
  });
});

describe("isRateLimitedError", () => {
  test("matches HTTP 429 regardless of the body code", () => {
    expect(
      isRateLimitedError(
        new ApiError({
          kind: "http",
          path: "/api/chat",
          status: 429,
          message: "slow down",
        }),
      ),
    ).toBe(true);
    expect(
      isRateLimitedError(
        new ApiError({
          kind: "http",
          path: "/api/chat",
          status: 429,
          code: "rate_limit_exceeded",
          message: "slow down",
        }),
      ),
    ).toBe(true);
  });

  test("matches the structured rate-limit code even on another status", () => {
    expect(
      isRateLimitedError(
        new ApiError({
          kind: "http",
          path: "/api/chat",
          status: 500,
          code: "rate_limit_exceeded",
          message: "limited",
        }),
      ),
    ).toBe(true);
  });

  test("rejects other statuses, non-ApiError values, and missing input", () => {
    expect(
      isRateLimitedError(
        new ApiError({
          kind: "http",
          path: "/api/chat",
          status: 503,
          message: "unavailable",
        }),
      ),
    ).toBe(false);
    expect(isRateLimitedError({ status: 429 })).toBe(false);
    expect(
      isRateLimitedError(Object.assign(new Error("nope"), { status: 429 })),
    ).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
  });
});

describe("isCloudAgentGoneError", () => {
  test("accepts agent_not_found with a 404 or an absent status", () => {
    expect(
      isCloudAgentGoneError(
        new ApiError({
          kind: "http",
          path: "/api/agents/a",
          status: 404,
          code: "agent_not_found",
          message: "gone",
        }),
      ),
    ).toBe(true);
    expect(
      isCloudAgentGoneError(
        new ApiError({
          kind: "http",
          path: "/api/agents/a",
          code: "agent_not_found",
          message: "gone",
        }),
      ),
    ).toBe(true);
  });

  test("does not treat other codes or statuses of the same shape as gone", () => {
    expect(
      isCloudAgentGoneError(
        new ApiError({
          kind: "http",
          path: "/api/agents/a",
          status: 404,
          code: "agent_not_running",
          message: "cold",
        }),
      ),
    ).toBe(false);
    expect(
      isCloudAgentGoneError(
        new ApiError({
          kind: "http",
          path: "/api/agents/a",
          status: 503,
          code: "agent_not_found",
          message: "odd",
        }),
      ),
    ).toBe(false);
  });

  test("walks the cause chain past recoverable states to the definitive row-gone error", () => {
    const gone = new ApiError({
      kind: "http",
      path: "/api/agents/a",
      status: 404,
      code: "agent_not_found",
      message: "row missing",
    });
    const cold = new ApiError({
      kind: "http",
      path: "/api/agents/a",
      status: 503,
      code: "agent_not_running",
      message: "not running",
    });

    expect(isCloudAgentGoneError(wrapError(gone))).toBe(true);
    expect(isCloudAgentGoneError(wrapError(cold))).toBe(false);
    expect(isCloudAgentGoneError(wrapError(wrapError(cold)))).toBe(false);

    const coldThenGone = new ApiError({
      kind: "http",
      path: "/api/agents/a",
      status: 503,
      code: "agent_not_running",
      message: "outer probe",
      cause: gone,
    });
    expect(isCloudAgentGoneError(coldThenGone)).toBe(true);

    const wrongStatusThenGone = new ApiError({
      kind: "http",
      path: "/api/agents/a",
      status: 503,
      code: "agent_not_found",
      message: "legacy body",
      cause: gone,
    });
    expect(isCloudAgentGoneError(wrongStatusThenGone)).toBe(true);
  });

  test("stops walking after five links", () => {
    const gone = new ApiError({
      kind: "http",
      path: "/api/agents/a",
      status: 404,
      code: "agent_not_found",
      message: "gone",
    });

    let reachable: unknown = gone;
    for (let depth = 0; depth < 4; depth += 1) {
      reachable = wrapError(reachable);
    }
    expect(isCloudAgentGoneError(reachable)).toBe(true);

    reachable = wrapError(reachable);
    expect(isCloudAgentGoneError(reachable)).toBe(false);
  });

  test("rejects non-Error input even when shaped like the gone marker", () => {
    expect(isCloudAgentGoneError(null)).toBe(false);
    expect(
      isCloudAgentGoneError({ code: "agent_not_found", status: 404 }),
    ).toBe(false);
    expect(isCloudAgentGoneError("agent_not_found")).toBe(false);
  });
});
