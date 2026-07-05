// Pins the error-policy boundary of Reddit ad-credential validation: a failed
// account-discovery fetch (transport reject or non-2xx) must surface its real error and
// stay DISTINCT from a valid-but-empty account list. Deterministic — global fetch is
// mocked; no live Reddit calls.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const originalFetch = globalThis.fetch;

let queue: Array<{ body: unknown; status?: number }> = [];

function enqueue(body: unknown, status = 200) {
  queue.push({ body, status });
}

function installQueuedFetch() {
  globalThis.fetch = mock(async () => {
    const next = queue.shift() ?? { body: { data: {} }, status: 200 };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function loadProvider() {
  const { redditAdsProvider } = await import("./reddit");
  return redditAdsProvider;
}

const credentials = { accessToken: "reddit-token" };
const EMPTY_ERROR = "No Reddit Ads accounts found or invalid credentials";

beforeEach(() => {
  queue = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("redditAdsProvider.validateCredentials error policy", () => {
  test("a network/transport failure surfaces the real error, not the empty-list message", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;

    const result = await (await loadProvider()).validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("network unreachable");
    // Transport failure must NOT be reported as a legitimately-empty account list.
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a non-2xx Reddit response surfaces the API error, distinct from empty", async () => {
    installQueuedFetch();
    enqueue({ error: { message: "Invalid access token" } }, 401);

    const result = await (await loadProvider()).validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid access token");
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a successful fetch with zero businesses is the DISTINCT legitimately-empty result", async () => {
    installQueuedFetch();
    enqueue({ data: [] });

    const result = await (await loadProvider()).validateCredentials(credentials);

    expect(result).toEqual({ valid: false, error: EMPTY_ERROR });
  });

  test("a successful fetch with an ad account validates without an error", async () => {
    installQueuedFetch();
    enqueue({ data: [{ id: "biz_1", name: "Business" }] });
    enqueue({ data: [{ id: "t2_account", name: "Reddit Account" }] });

    const result = await (await loadProvider()).validateCredentials(credentials);

    expect(result).toEqual({
      valid: true,
      accountId: "t2_account",
      accountName: "Reddit Account",
    });
  });
});
