// Pins the error-surfacing contract of the Snap ad provider: a failed/invalid
// provider fetch must PROPAGATE, and must stay distinct from a legitimately-empty
// account list (valid credentials, no ad accounts). Deterministic — global fetch
// is mocked; no live Snap Marketing API call.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { snapAdsProvider } = await import("./snap");

const originalFetch = globalThis.fetch;

function mockFetchJson(body: unknown, status = 200) {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as typeof fetch;
}

function mockFetchReject(error: Error) {
  globalThis.fetch = mock(async () => {
    throw error;
  }) as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("snapAdsProvider.validateCredentials error surfacing", () => {
  test("propagates a transport failure instead of reporting invalid credentials", async () => {
    mockFetchReject(new Error("network down"));

    await expect(snapAdsProvider.validateCredentials({ accessToken: "token" })).rejects.toThrow(
      "network down",
    );
  });

  test("propagates a Snap API error (non-success request_status) instead of swallowing it", async () => {
    mockFetchJson({
      request_status: "ERROR",
      request_id: "req_1",
      message: "Invalid OAuth access token",
    });

    await expect(snapAdsProvider.validateCredentials({ accessToken: "bad-token" })).rejects.toThrow(
      "Invalid OAuth access token",
    );
  });

  test("propagates a non-2xx transport error instead of swallowing it", async () => {
    mockFetchJson({ request_status: "ERROR", debug_message: "unauthorized" }, 401);

    await expect(snapAdsProvider.validateCredentials({ accessToken: "bad-token" })).rejects.toThrow(
      "unauthorized",
    );
  });

  test("returns a resolved invalid result (not a throw) for a legitimately-empty account list", async () => {
    mockFetchJson({
      request_status: "SUCCESS",
      request_id: "req_2",
      organizations: [{ organization: { id: "org_1", ad_accounts: [] } }],
    });

    const result = await snapAdsProvider.validateCredentials({ accessToken: "token" });

    expect(result).toEqual({
      valid: false,
      error: "No Snap ad accounts found or invalid credentials",
    });
  });

  test("resolves valid for a populated account list", async () => {
    mockFetchJson({
      request_status: "SUCCESS",
      request_id: "req_3",
      organizations: [
        {
          organization: {
            id: "org_1",
            ad_accounts: [{ id: "act_1", name: "Acme" }],
          },
        },
      ],
    });

    const result = await snapAdsProvider.validateCredentials({ accessToken: "token" });

    expect(result).toEqual({
      valid: true,
      accountId: "act_1",
      accountName: "Acme",
    });
  });
});
