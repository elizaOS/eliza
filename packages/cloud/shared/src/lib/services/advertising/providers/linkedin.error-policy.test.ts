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
  const { linkedinAdsProvider, linkedinFetch } = await import("./linkedin");
  return { provider: linkedinAdsProvider, linkedinFetch };
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

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("network unreachable");
    // Transport failure must NOT be reported as a legitimately-empty account list.
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a non-2xx LinkedIn response surfaces the API error, distinct from empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ message: "Invalid access token" }, 401),
    ) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid access token");
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a successful fetch with zero accounts is the DISTINCT legitimately-empty result", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ elements: [] })) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result).toEqual({ valid: false, error: EMPTY_ERROR });
  });

  test("a successful fetch with an account validates without an error", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ elements: [{ id: 507404993, name: "Dunder Mifflin Account" }] }),
    ) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result).toEqual({
      valid: true,
      accountId: "507404993",
      accountName: "Dunder Mifflin Account",
    });
  });
});

describe("linkedinFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung LinkedIn API hop at the timeout", async () => {
    // An API that never settles on its own: the only way out is the caller's
    // AbortSignal firing (the 30s default bounds every ads / upload hop).
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const start = Date.now();
    const { linkedinFetch } = await loadProvider();
    await expect(
      linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("composes a caller-provided abort signal with the hop deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return jsonResponse({ elements: [] });
    }) as typeof fetch;

    const { linkedinFetch } = await loadProvider();
    const controller = new AbortController();
    await linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", {
      signal: controller.signal,
    });
    // The wrapper owns the deadline, so the signal handed to the transport is
    // a composition of the caller's signal and that deadline — never the caller's
    // object verbatim. Asserting identity here would pin the very behavior that
    // lets a never-firing caller signal defeat the bound.
    expect(seen).not.toBe(controller.signal);
  });
});
