// Error-policy proof for the X Ads provider (#13415): a failed provider fetch/auth must surface a
// DISTINCT invalid state from a legitimately-empty result — a transport failure is never collapsed
// into "no accounts found", and a failed spend-metrics fetch never fabricates zeroed metrics. Uses
// mock.module + dynamic import with a mocked global fetch; asserts no monetary value.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { error() {}, warn() {}, info() {}, debug() {} },
}));

const originalFetch = globalThis.fetch;
const originalConsumerKey = process.env.X_ADS_CONSUMER_KEY;
const originalConsumerSecret = process.env.X_ADS_CONSUMER_SECRET;

const CREDS = { accessToken: "user-token", refreshToken: "token-secret" };
const EMPTY_MESSAGE = "No X Ads accounts found or invalid credentials";

function respondWith(handler: (input: RequestInfo | URL) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => handler(input)) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function loadProvider() {
  const mod = await import("./x-twitter");
  return mod.xTwitterAdsProvider;
}

beforeEach(() => {
  process.env.X_ADS_CONSUMER_KEY = "consumer-key";
  process.env.X_ADS_CONSUMER_SECRET = "consumer-secret";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalConsumerKey === undefined) delete process.env.X_ADS_CONSUMER_KEY;
  else process.env.X_ADS_CONSUMER_KEY = originalConsumerKey;
  if (originalConsumerSecret === undefined) delete process.env.X_ADS_CONSUMER_SECRET;
  else process.env.X_ADS_CONSUMER_SECRET = originalConsumerSecret;
});

describe("xTwitterAdsProvider error policy", () => {
  test("validateCredentials surfaces an auth (4xx) failure as its own error, distinct from empty", async () => {
    respondWith(() => jsonResponse({ errors: [{ message: "Unauthorized" }] }, 401));
    const provider = await loadProvider();

    const result = await provider.validateCredentials(CREDS);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Unauthorized");
    // The transport/auth failure must NOT be reported as the legitimately-empty case.
    expect(result.error).not.toBe(EMPTY_MESSAGE);
  });

  test("validateCredentials surfaces a network reject as its own error, distinct from empty", async () => {
    respondWith(() => {
      throw new Error("network unreachable");
    });
    const provider = await loadProvider();

    const result = await provider.validateCredentials(CREDS);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("network unreachable");
    expect(result.error).not.toBe(EMPTY_MESSAGE);
  });

  test("validateCredentials reports a legitimately-empty account list distinctly from a fetch failure", async () => {
    respondWith(() => jsonResponse({ data: [] }));
    const provider = await loadProvider();

    const result = await provider.validateCredentials(CREDS);

    expect(result).toEqual({ valid: false, error: EMPTY_MESSAGE });
    // Empty is a designed invalid state, never fabricated as valid.
    expect(result.valid).toBe(false);
  });

  test("getCampaignMetrics fails closed on a transport error rather than fabricating metrics", async () => {
    respondWith(() => jsonResponse({ errors: [{ message: "server exploded" }] }, 500));
    const provider = await loadProvider();

    const result = await provider.getCampaignMetrics(CREDS, "acct_1/camp_1/line_1", {
      start: new Date("2026-07-01T00:00:00Z"),
      end: new Date("2026-07-02T00:00:00Z"),
    });

    // A failed spend-metrics fetch surfaces as failure and carries NO fabricated metrics object —
    // distinct from a successful-but-empty stats response (which would be { success: true }).
    expect(result.success).toBe(false);
    expect(result.error).toBe("server exploded");
    expect(result.metrics).toBeUndefined();
  });
});
