// Pins the error-surfacing contract of the TikTok ad provider: a failed/invalid
// provider fetch must PROPAGATE, and must stay distinct from a legitimately-empty
// account list (valid credentials, no ad accounts). Deterministic — global fetch
// is mocked; no live TikTok Marketing API call.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { tiktokAdsProvider } = await import("./tiktok");

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

describe("tiktokAdsProvider.validateCredentials error surfacing", () => {
  test("propagates a transport failure instead of reporting invalid credentials", async () => {
    mockFetchReject(new Error("network down"));

    await expect(tiktokAdsProvider.validateCredentials({ accessToken: "token" })).rejects.toThrow(
      "network down",
    );
  });

  test("propagates a TikTok API error (code != 0) instead of swallowing it", async () => {
    mockFetchJson({
      code: 40001,
      message: "Invalid access token",
      request_id: "req_1",
      data: {},
    });

    await expect(
      tiktokAdsProvider.validateCredentials({ accessToken: "bad-token" }),
    ).rejects.toThrow("Invalid access token");
  });

  test("returns a resolved invalid result (not a throw) for a legitimately-empty account list", async () => {
    mockFetchJson({
      code: 0,
      message: "OK",
      request_id: "req_2",
      data: { list: [] },
    });

    const result = await tiktokAdsProvider.validateCredentials({ accessToken: "token" });

    expect(result).toEqual({
      valid: false,
      error: "No TikTok Ads accounts found or invalid credentials",
    });
  });

  test("resolves valid for a populated account list", async () => {
    mockFetchJson({
      code: 0,
      message: "OK",
      request_id: "req_3",
      data: {
        list: [{ advertiser_id: "adv_1", advertiser_name: "Acme", status: "STATUS_ENABLE" }],
      },
    });

    const result = await tiktokAdsProvider.validateCredentials({ accessToken: "token" });

    expect(result).toEqual({
      valid: true,
      accountId: "adv_1",
      accountName: "Acme",
    });
  });
});
