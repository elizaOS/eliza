/**
 * Tests for cloud/auth.ts — the Eliza Cloud login flow.
 *
 * Exercises:
 *   - Session creation (success, HTTP errors)
 *   - Polling loop (pending → authenticated, timeout, expiry)
 *   - Browser URL construction
 *   - API key extraction from response
 *   - Edge cases: key already retrieved, 404 mid-poll
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./validate-url", () => {
  return {
    validateCloudBaseUrl: vi.fn().mockResolvedValue(null),
  };
});

import { cloudLogin } from "./auth";

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

const fetchMock =
  vi.fn<
    (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  >();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timeoutError(message = "The operation was aborted due to timeout") {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cloudLogin", () => {
  it("creates session, polls, and returns API key on success", async () => {
    let pollCount = 0;
    const capturedUrls: string[] = [];

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      capturedUrls.push(url);

      // Session creation
      if (
        url.includes("/api/auth/cli-session") &&
        !url.includes("/api/auth/cli-session/")
      ) {
        return jsonResponse(
          { sessionId: "test-session", status: "pending" },
          201,
        );
      }

      // Poll endpoint
      if (url.includes("/api/auth/cli-session/")) {
        pollCount++;
        if (pollCount < 3) {
          return jsonResponse({ status: "pending" });
        }
        return jsonResponse({
          status: "authenticated",
          apiKey: "eliza_test123",
          keyPrefix: "eliza_test",
          expiresAt: null,
        });
      }

      return new Response("Not found", { status: 404 });
    });

    let browserUrl = "";
    const result = await cloudLogin({
      baseUrl: "https://test.elizacloud.ai",
      pollIntervalMs: 10,
      timeoutMs: 5000,
      onBrowserUrl: (url) => {
        browserUrl = url;
      },
    });

    expect(result.apiKey).toBe("eliza_test123");
    expect(result.keyPrefix).toBe("eliza_test");
    expect(result.expiresAt).toBeNull();
    expect(browserUrl).toContain(
      "https://test.elizacloud.ai/auth/cli-login?session=",
    );
    expect(pollCount).toBe(3);
  });

  it("throws on session creation failure", async () => {
    fetchMock.mockResolvedValue(new Response("Server Error", { status: 500 }));

    await expect(
      cloudLogin({
        baseUrl: "https://test.elizacloud.ai",
        pollIntervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Failed to create auth session");
  });

  it("throws on timeout when login is never completed", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (
        url.includes("/api/auth/cli-session") &&
        !url.includes("/api/auth/cli-session/")
      ) {
        return jsonResponse({ sessionId: "test-session" }, 201);
      }
      // Always pending
      return jsonResponse({ status: "pending" });
    });

    await expect(
      cloudLogin({
        baseUrl: "https://test.elizacloud.ai",
        pollIntervalMs: 10,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("Cloud login timed out");
  });

  it("throws when session creation request times out", async () => {
    fetchMock.mockRejectedValue(timeoutError());

    await expect(
      cloudLogin({
        baseUrl: "https://test.elizacloud.ai",
        requestTimeoutMs: 20,
      }),
    ).rejects.toThrow("creating session");
  });

  it("throws when poll request times out", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return jsonResponse({ sessionId: "test-session" }, 201);
      }
      throw timeoutError();
    });

    await expect(
      cloudLogin({
        baseUrl: "https://test.elizacloud.ai",
        pollIntervalMs: 1,
        timeoutMs: 5000,
        requestTimeoutMs: 20,
      }),
    ).rejects.toThrow("polling request timed out");
  });

  it("sets per-request timeout signal on cloud fetches", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    let callCount = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      signals.push(init?.signal);
      redirects.push(init?.redirect);
      callCount++;
      if (callCount === 1)
        return jsonResponse({ sessionId: "test-session" }, 201);
      return jsonResponse({
        status: "authenticated",
        apiKey: "k",
        keyPrefix: "k",
      });
    });

    await cloudLogin({
      baseUrl: "https://test.elizacloud.ai",
      pollIntervalMs: 1,
      timeoutMs: 5000,
      requestTimeoutMs: 50,
    });

    expect(signals.length).toBeGreaterThanOrEqual(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    for (const redirect of redirects) {
      expect(redirect).toBe("manual");
    }
  });

  it("rejects redirect responses during session creation", async () => {
    fetchMock.mockResolvedValue(
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
    );

    await expect(
      cloudLogin({
        baseUrl: "https://test.elizacloud.ai",
        requestTimeoutMs: 50,
      }),
    ).rejects.toThrow("redirected");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.elizacloud.ai/api/auth/cli-session",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("throws when session becomes 404 mid-poll", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (
        url.includes("/api/auth/cli-session") &&
        !url.includes("/api/auth/cli-session/")
      ) {
        return jsonResponse({ sessionId: "test-session" }, 201);
      }
      callCount++;
      if (callCount >= 2) {
        return new Response("Not found", { status: 404 });
      }
      return jsonResponse({ status: "pending" });
    });

    await expect(
      cloudLogin({
        baseUrl: "https://test.elizacloud.ai",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("Auth session expired or not found");
  });

  it("throws when authenticated but key already retrieved", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (
        url.includes("/api/auth/cli-session") &&
        !url.includes("/api/auth/cli-session/")
      ) {
        return jsonResponse({ sessionId: "test-session" }, 201);
      }
      // Authenticated but no apiKey (already retrieved by another client)
      return jsonResponse({
        status: "authenticated",
        message: "API key already retrieved",
      });
    });

    await expect(
      cloudLogin({
        baseUrl: "https://test.elizacloud.ai",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("API key was already retrieved");
  });

  it("strips trailing slashes from baseUrl", async () => {
    const capturedUrls: string[] = [];
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      capturedUrls.push(url);

      if (!url.includes("/api/auth/cli-session/")) {
        return jsonResponse({ sessionId: "s" }, 201);
      }
      return jsonResponse({
        status: "authenticated",
        apiKey: "k",
        keyPrefix: "p",
      });
    });

    await cloudLogin({
      baseUrl: "https://test.elizacloud.ai///",
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });

    // No double slashes in any URL
    for (const url of capturedUrls) {
      expect(url).not.toMatch(/https:\/\/test\.elizacloud\.ai\/\//);
    }
  });

  it("calls onPollStatus with each status", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (!url.includes("/api/auth/cli-session/")) {
        return jsonResponse({ sessionId: "s" }, 201);
      }
      callCount++;
      if (callCount < 2) return jsonResponse({ status: "pending" });
      return jsonResponse({
        status: "authenticated",
        apiKey: "k",
        keyPrefix: "p",
      });
    });

    const statuses: string[] = [];
    await cloudLogin({
      baseUrl: "https://test.elizacloud.ai",
      pollIntervalMs: 10,
      timeoutMs: 5000,
      onPollStatus: (s) => statuses.push(s),
    });

    expect(statuses).toContain("pending");
    expect(statuses).toContain("authenticated");
  });
});
