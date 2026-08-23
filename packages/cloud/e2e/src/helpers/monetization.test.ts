/**
 * Focused deterministic coverage of the monetization e2e helpers: authed JSON
 * client construction, inference cache-warming retries, Cerebras configuration
 * gating, and the test-only app-approval path. Sibling helper tests in this
 * package run under Bun; this file is collected by the repository Vitest lane
 * (`bunx vitest run packages/cloud/e2e/src/helpers/monetization.test.ts`).
 */

import { appsService } from "@elizaos/cloud-shared/lib/services/apps";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type AuthedClient,
  type AuthedResponse,
  approveAppForMonetizationTest,
  authedClient,
  cerebrasConfigured,
  REAL_LLM_BILLING_SOURCE,
  REAL_LLM_MAX_TOKENS,
  REAL_LLM_MODEL,
  retryInferenceCacheWarming,
} from "./monetization";

vi.mock("@elizaos/cloud-shared/lib/services/apps", () => ({
  appsService: {
    update: vi.fn(async (id: string) => ({ id })),
  },
}));

const originalFetch = globalThis.fetch;
const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
const updateApp = vi.mocked(appsService.update);

const WARMING_MESSAGES = [
  "Authorization cache is warming. Retry shortly.",
  "Rate-limit authorization cache is warming. Retry shortly.",
  "Application authorization cache is warming. Retry shortly.",
  "Moderation authorization cache is warming. Retry shortly.",
  "Billing authorization is warming. Retry shortly.",
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  updateApp.mockClear();
  updateApp.mockImplementation(async (id: string) => ({ id }) as never);
  if (originalCerebrasKey === undefined) {
    delete process.env.CEREBRAS_API_KEY;
  } else {
    process.env.CEREBRAS_API_KEY = originalCerebrasKey;
  }
});

type FetchResult = {
  status: number;
  json?: unknown;
  jsonError?: Error;
};

type RecordedRequest = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
};

function installFetch(
  impl: (request: RecordedRequest) => FetchResult | Promise<FetchResult>,
): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers && typeof init.headers === "object") {
        Object.assign(headers, init.headers);
      }
      const recorded: RecordedRequest = {
        url: String(input),
        method: init?.method,
        headers,
        body: init?.body === undefined ? undefined : String(init.body),
      };
      calls.push(recorded);
      const result = await impl(recorded);
      return {
        status: result.status,
        json: async () => {
          if (result.jsonError) throw result.jsonError;
          return result.json;
        },
      } as Response;
    },
  ) as unknown as typeof fetch;
  return calls;
}

function stubClient(
  impl: (
    method: string,
    path: string,
    body: unknown,
  ) => Promise<AuthedResponse<unknown>>,
): AuthedClient {
  return (async (method: string, path: string, body?: unknown) =>
    impl(method, path, body)) as AuthedClient;
}

function warmingBody(message: string) {
  return {
    type: "error",
    error: { type: "api_error", message },
  };
}

function warmingResponse(message: string): AuthedResponse<unknown> {
  return { status: 503, json: warmingBody(message) };
}

describe("exported model constants", () => {
  test("pin the native Cerebras default text model and its full output budget", () => {
    expect(REAL_LLM_MODEL).toBe("cerebras/gemma-4-31b");
    expect(REAL_LLM_BILLING_SOURCE).toBe("cerebras");
    expect(REAL_LLM_MAX_TOKENS).toBe(40000);
  });
});

describe("cerebrasConfigured", () => {
  test("is false when the key is missing, empty, or whitespace", () => {
    delete process.env.CEREBRAS_API_KEY;
    expect(cerebrasConfigured()).toBe(false);

    process.env.CEREBRAS_API_KEY = "";
    expect(cerebrasConfigured()).toBe(false);

    process.env.CEREBRAS_API_KEY = "   \t\n";
    expect(cerebrasConfigured()).toBe(false);
  });

  test("is true when the key has non-whitespace content", () => {
    process.env.CEREBRAS_API_KEY = "sk-live";
    expect(cerebrasConfigured()).toBe(true);

    process.env.CEREBRAS_API_KEY = "  sk-live  ";
    expect(cerebrasConfigured()).toBe(true);
  });
});

describe("authedClient", () => {
  test("sends both bearer and API-key headers and concatenates api+path", async () => {
    const calls = installFetch(() => ({ status: 200, json: { ok: true } }));
    const client = authedClient("https://api.example.test", "key-1");
    const result = await client<{ ok: boolean }>("GET", "/api/v1/me");

    expect(result).toEqual({ status: 200, json: { ok: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: "https://api.example.test/api/v1/me",
      method: "GET",
      headers: {
        Authorization: "Bearer key-1",
        "X-API-Key": "key-1",
      },
      body: undefined,
    });
  });

  test("omits Content-Type and body when the payload is absent or falsy", async () => {
    const calls = installFetch(() => ({ status: 204, json: {} }));
    const client = authedClient("https://api.example.test", "key-1");

    await client("DELETE", "/api/v1/apps/1");
    await client("POST", "/api/v1/apps/1", undefined);
    await client("POST", "/api/v1/apps/1", null);
    await client("POST", "/api/v1/apps/1", 0);
    await client("POST", "/api/v1/apps/1", "");
    await client("POST", "/api/v1/apps/1", false);

    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call.headers["Content-Type"]).toBeUndefined();
      expect(call.body).toBeUndefined();
    }
  });

  test("JSON-encodes a truthy body and lets extra headers override defaults", async () => {
    const calls = installFetch(() => ({ status: 201, json: { id: "app-1" } }));
    const client = authedClient("https://api.example.test", "key-1");
    const result = await client(
      "POST",
      "/api/v1/apps",
      { name: "demo" },
      {
        "X-App-Id": "app-1",
        "X-Affiliate-Code": "aff-9",
        Authorization: "Bearer override",
      },
    );

    expect(result.status).toBe(201);
    expect(result.json).toEqual({ id: "app-1" });
    expect(calls[0]?.headers).toEqual({
      Authorization: "Bearer override",
      "X-API-Key": "key-1",
      "Content-Type": "application/json",
      "X-App-Id": "app-1",
      "X-Affiliate-Code": "aff-9",
    });
    expect(calls[0]?.body).toBe(JSON.stringify({ name: "demo" }));
  });

  test("returns an empty object when the response body is not JSON", async () => {
    installFetch(() => ({
      status: 502,
      jsonError: new SyntaxError("not json"),
    }));
    const client = authedClient("https://api.example.test", "key-1");
    await expect(client("GET", "/health")).resolves.toEqual({
      status: 502,
      json: {},
    });
  });

  test("does not insert a slash between api and path", async () => {
    const calls = installFetch(() => ({ status: 200, json: {} }));
    const client = authedClient("https://api.example.test/base", "key-1");
    await client("GET", "relative");
    expect(calls[0]?.url).toBe("https://api.example.test/baserelative");
  });
});

describe("retryInferenceCacheWarming", () => {
  test("returns the first response when it is not a warming 503", async () => {
    let calls = 0;
    const first: AuthedResponse<{ ok: true }> = {
      status: 200,
      json: { ok: true },
    };
    const result = await retryInferenceCacheWarming(async () => {
      calls += 1;
      return first;
    });
    expect(result).toBe(first);
    expect(calls).toBe(1);
  });

  test("retries each named warming message and then returns the next envelope", async () => {
    for (const message of WARMING_MESSAGES) {
      const responses: AuthedResponse<unknown>[] = [
        warmingResponse(message),
        { status: 200, json: { text: "ok" } },
      ];
      const result = await retryInferenceCacheWarming(async () => {
        const next = responses.shift();
        if (!next) throw new Error("unexpected extra request");
        return next;
      });
      expect(result).toEqual({ status: 200, json: { text: "ok" } });
      expect(responses).toHaveLength(0);
    }
  });

  test("does not retry foreign, malformed, or non-503 warming-shaped envelopes", async () => {
    const envelopes: AuthedResponse<unknown>[] = [
      { status: 500, json: warmingBody(WARMING_MESSAGES[0]) },
      { status: 503, json: null },
      { status: 503, json: undefined },
      { status: 503, json: 0 },
      { status: 503, json: "warming" },
      { status: 503, json: { type: "error" } },
      {
        status: 503,
        json: {
          type: "other",
          error: { type: "api_error", message: WARMING_MESSAGES[0] },
        },
      },
      {
        status: 503,
        json: {
          type: "error",
          error: { type: "rate_limit", message: WARMING_MESSAGES[0] },
        },
      },
      {
        status: 503,
        json: { type: "error", error: { type: "api_error", message: 12 } },
      },
      {
        status: 503,
        json: {
          type: "error",
          error: { type: "api_error", message: "Provider overloaded." },
        },
      },
      {
        status: 503,
        json: {
          type: "error",
          error: {
            type: "api_error",
            message: ` ${WARMING_MESSAGES[0]} `,
          },
        },
      },
    ];

    for (const envelope of envelopes) {
      let calls = 0;
      const result = await retryInferenceCacheWarming(async () => {
        calls += 1;
        return envelope;
      });
      expect(result).toBe(envelope);
      expect(calls).toBe(1);
    }
  });

  test("exhausts the default eight attempts and returns the last warming response", async () => {
    let calls = 0;
    const last = warmingResponse(WARMING_MESSAGES[0]);
    const result = await retryInferenceCacheWarming(async () => {
      calls += 1;
      return calls === 8 ? last : warmingResponse(WARMING_MESSAGES[1]);
    });
    expect(calls).toBe(8);
    expect(result).toBe(last);
  });

  test("honours a custom maxAttempts, including a single-shot budget", async () => {
    let twoShotCalls = 0;
    const twoShot = await retryInferenceCacheWarming(async () => {
      twoShotCalls += 1;
      return warmingResponse(WARMING_MESSAGES[0]);
    }, 2);
    expect(twoShotCalls).toBe(2);
    expect(twoShot.status).toBe(503);

    let singleShotCalls = 0;
    const first = warmingResponse(WARMING_MESSAGES[0]);
    const singleShot = await retryInferenceCacheWarming(async () => {
      singleShotCalls += 1;
      return first;
    }, 1);
    expect(singleShotCalls).toBe(1);
    expect(singleShot).toBe(first);
  });
});

describe("approveAppForMonetizationTest", () => {
  test("approves through the service then cache-busts with a logo PATCH", async () => {
    const before = Date.now();
    const clientCalls: Array<{
      method: string;
      path: string;
      body: unknown;
    }> = [];
    const client = stubClient(async (method, path, body) => {
      clientCalls.push({ method, path, body });
      return { status: 200, json: { ok: true } };
    });

    await approveAppForMonetizationTest("app-42", client);

    expect(updateApp).toHaveBeenCalledTimes(1);
    const [appId, data] = updateApp.mock.calls[0] ?? [];
    expect(appId).toBe("app-42");
    expect(data?.review_status).toBe("approved");
    expect(data?.review_content_hash).toBeNull();
    const reviewedAt = data?.reviewed_at;
    expect(reviewedAt).toBeInstanceOf(Date);
    if (!(reviewedAt instanceof Date)) {
      throw new Error("expected reviewed_at to be a Date");
    }
    expect(reviewedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(reviewedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(clientCalls).toEqual([
      {
        method: "PATCH",
        path: "/api/v1/apps/app-42",
        body: { logo_url: "https://example.com/monetization-test-app.png" },
      },
    ]);
  });

  test("throws when the service cannot find the app and never calls the client", async () => {
    updateApp.mockResolvedValueOnce(undefined);
    let clientCalls = 0;
    const client = stubClient(async () => {
      clientCalls += 1;
      return { status: 200, json: {} };
    });

    await expect(
      approveAppForMonetizationTest("missing-app", client),
    ).rejects.toThrow(
      "Cannot approve missing monetization test app: missing-app",
    );
    expect(clientCalls).toBe(0);
  });

  test("throws when the cache-bust PATCH is not 200", async () => {
    const client = stubClient(async () => ({
      status: 409,
      json: { error: "conflict" },
    }));
    await expect(
      approveAppForMonetizationTest("app-42", client),
    ).rejects.toThrow(
      "Cannot invalidate monetization test app cache: app-42 (409)",
    );
  });
});
