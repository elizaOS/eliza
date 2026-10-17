/**
 * Pins how `cloudLogin` treats a 200 poll response whose body is not JSON:
 * a one-off glitch keeps polling, but a persistent failure (e.g. a proxy
 * returning HTML) surfaces as an invalid-response error carrying the parse
 * error as its cause instead of a false "browser login not completed" timeout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `validateCloudBaseUrl` performs DNS lookups; the poll handling under test
// does not depend on it.
vi.mock("../src/cloud/validate-url.js", () => ({
  validateCloudBaseUrl: vi.fn(async () => null),
}));

import { logger } from "@elizaos/core";
import { cloudLogin } from "../src/cloud/auth.js";

const SESSION_ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const BASE_URL = "https://cloud.example.test";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function html(): Response {
  return new Response("<html><body>blocked</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

const originalFetch = globalThis.fetch;

function mockFetch(pollResponses: Array<() => Response | Promise<Response>>): void {
  let pollIndex = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE_URL}/api/auth/cli-session` && init?.method === "POST") {
      return json({ sessionId: SESSION_ID });
    }
    if (url === `${BASE_URL}/api/auth/cli-session/${SESSION_ID}`) {
      const next = pollResponses[Math.min(pollIndex, pollResponses.length - 1)];
      pollIndex += 1;
      return next();
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("cloudLogin poll response parsing", () => {
  it("keeps polling past a transient unparseable body and logs it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    mockFetch([
      html,
      () => json({ status: "authenticated", apiKey: "eliza_key", keyPrefix: "eliza_" }),
    ]);
    const statuses: string[] = [];

    const result = await cloudLogin({
      baseUrl: BASE_URL,
      pollIntervalMs: 1,
      onPollStatus: (status) => statuses.push(status),
    });

    expect(result).toEqual({ apiKey: "eliza_key", keyPrefix: "eliza_", expiresAt: null });
    expect(statuses).toEqual(["error", "authenticated"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("content-type: text/html");
  });

  it("fails with the parse error as cause when every poll body is unparseable", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    mockFetch([html]);

    const error = await cloudLogin({ baseUrl: BASE_URL, pollIntervalMs: 1 }).catch(
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Eliza Cloud returned invalid login poll responses");
    expect((error as Error).message).not.toContain("browser login was not completed");
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("accepts null optional fields from an authenticated poll", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    mockFetch([
      () =>
        json({
          status: "authenticated",
          apiKey: "eliza_key",
          keyPrefix: null,
          expiresAt: null,
        }),
    ]);

    const result = await cloudLogin({ baseUrl: BASE_URL, pollIntervalMs: 1 });

    expect(result).toEqual({ apiKey: "eliza_key", keyPrefix: "", expiresAt: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects parsed poll bodies that do not match the login contract", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    for (const body of [
      null,
      {},
      {
        status: "authenticated",
        apiKey: { not: "a string" },
        keyPrefix: 7,
        expiresAt: 42,
      },
    ]) {
      mockFetch([() => json(body)]);

      const error = await cloudLogin({
        baseUrl: BASE_URL,
        pollIntervalMs: 1,
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Eliza Cloud returned invalid login poll responses");
      expect((error as Error).cause).toBeInstanceOf(TypeError);
    }
  });

  it("reports the parse failure instead of a timeout when the deadline hits first", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    // The second unparseable poll only resolves after the deadline, so the
    // loop exits on the deadline (not the consecutive-failure cap).
    mockFetch([
      () => json({ status: "pending" }),
      html,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return html();
      },
    ]);

    const error = await cloudLogin({
      baseUrl: BASE_URL,
      pollIntervalMs: 1,
      timeoutMs: 500,
    }).catch((err: unknown) => err);

    expect((error as Error).message).toBe("Eliza Cloud returned invalid login poll responses");
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("still reports a genuine timeout when polls parse but stay pending", async () => {
    mockFetch([() => json({ status: "pending" })]);

    await expect(
      cloudLogin({ baseUrl: BASE_URL, pollIntervalMs: 5, timeoutMs: 30 })
    ).rejects.toThrow("Cloud login timed out");
  });
});
