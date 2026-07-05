// Pins the error-policy boundary of LinkedIn ad-credential validation: a failed
// account-discovery fetch (transport reject or non-2xx) must surface its real
// error and stay DISTINCT from a valid-but-empty account list. Deterministic —
// global fetch is mocked; no live LinkedIn calls.
import { afterEach, describe, expect, mock, test } from "bun:test";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function loadProvider() {
  const { linkedinAdsProvider } = await import("./linkedin");
  return linkedinAdsProvider;
}

const credentials = { accessToken: "linkedin-token" };
const EMPTY_ERROR = "No LinkedIn ad accounts found or invalid credentials";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("linkedinAdsProvider.validateCredentials error policy", () => {
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

  test("a non-2xx LinkedIn response surfaces the API error, distinct from empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ message: "Invalid access token" }, 401),
    ) as typeof fetch;

    const result = await (await loadProvider()).validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid access token");
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a successful fetch with zero accounts is the DISTINCT legitimately-empty result", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ elements: [] })) as typeof fetch;

    const result = await (await loadProvider()).validateCredentials(credentials);

    expect(result).toEqual({ valid: false, error: EMPTY_ERROR });
  });

  test("a successful fetch with an account validates without an error", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ elements: [{ id: 507404993, name: "Dunder Mifflin Account" }] }),
    ) as typeof fetch;

    const result = await (await loadProvider()).validateCredentials(credentials);

    expect(result).toEqual({
      valid: true,
      accountId: "507404993",
      accountName: "Dunder Mifflin Account",
    });
  });
});
