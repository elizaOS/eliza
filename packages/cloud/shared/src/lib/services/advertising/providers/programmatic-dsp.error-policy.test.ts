// Pins the error-policy boundary of the programmatic DSP adapter: a failed or
// malformed provider fetch must SURFACE (propagate or become a structured
// failure) and stay distinguishable from a legitimately empty result, so a
// broken reporting fetch can never read as zero spend. Deterministic harness —
// global fetch is mocked per test; no live DSP or real model involved.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));

const { programmaticDspProvider } = await import("./programmatic-dsp");

const originalFetch = globalThis.fetch;
const originalEndpoint = process.env.PROGRAMMATIC_DSP_ENDPOINT;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = mock(fn) as typeof fetch;
}

beforeEach(() => {
  process.env.PROGRAMMATIC_DSP_ENDPOINT = "https://dsp.example.com/rtb";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEndpoint === undefined) delete process.env.PROGRAMMATIC_DSP_ENDPOINT;
  else process.env.PROGRAMMATIC_DSP_ENDPOINT = originalEndpoint;
});

describe("programmaticDspProvider error policy", () => {
  test("a 200 with a non-JSON body propagates as a transport failure, not an empty envelope", async () => {
    setFetch(async () => new Response("<html>502 Bad Gateway</html>", { status: 200 }));
    await expect(programmaticDspProvider.listAdAccounts({ accessToken: "token" })).rejects.toThrow(
      /non-JSON body/,
    );
  });

  test("a non-ok JSON error body still surfaces the provider's error message", async () => {
    setFetch(async () => jsonResponse({ error: { message: "unauthorized" } }, 401));
    await expect(programmaticDspProvider.listAdAccounts({ accessToken: "bad" })).rejects.toThrow(
      "unauthorized",
    );
  });

  test("an empty body on a mutating call stays a legitimate no-content success (no throw)", async () => {
    setFetch(async () => new Response("", { status: 200 }));
    await expect(
      programmaticDspProvider.updateCampaign({ accessToken: "token" }, "adv_1/cmp_1/li_1", {
        name: "Renamed",
      }),
    ).resolves.toMatchObject({ success: true });
  });

  test("validateCredentials surfaces a transport failure verbatim, distinct from an empty account list", async () => {
    setFetch(async () => {
      throw new Error("ECONNREFUSED dsp.example.com");
    });
    const failure = await programmaticDspProvider.validateCredentials({ accessToken: "token" });
    expect(failure.valid).toBe(false);
    expect(failure.error).toContain("ECONNREFUSED");
    expect(failure.error).not.toContain("No DSP advertiser accounts");

    setFetch(async () => jsonResponse({ data: [] }));
    const empty = await programmaticDspProvider.validateCredentials({ accessToken: "token" });
    expect(empty).toEqual({
      valid: false,
      error: "No DSP advertiser accounts found or invalid credentials",
    });
  });

  test("metrics: a broken report fetch fails closed and is distinct from a legitimately empty report", async () => {
    // Parse failure on the reporting endpoint must NOT fabricate zero spend.
    setFetch(async () => new Response("upstream timeout", { status: 200 }));
    const broken = await programmaticDspProvider.getCampaignMetrics(
      { accessToken: "token" },
      "adv_1/cmp_1/li_1",
    );
    expect(broken.success).toBe(false);
    expect(broken.error).toBeTruthy();
    expect(broken.metrics).toBeUndefined();

    // A genuinely empty report is a success with zeroed metrics — the opposite verdict.
    setFetch(async () => jsonResponse({ data: { rows: [] } }));
    const empty = await programmaticDspProvider.getCampaignMetrics(
      { accessToken: "token" },
      "adv_1/cmp_1/li_1",
    );
    expect(empty.success).toBe(true);
    expect(empty.metrics).toBeDefined();
  });
});
