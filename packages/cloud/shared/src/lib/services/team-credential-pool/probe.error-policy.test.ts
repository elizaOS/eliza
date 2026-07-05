/**
 * Error-policy proof for the pooled-key live probe: a transport failure must
 * surface as a distinguishable structured failure (never a fabricated
 * `ok:true`), a revoked key must keep its real HTTP status, and a body-read
 * failure must not clobber that status. Drives the real exported
 * `probePooledApiKey` against a stubbed global `fetch` (no network, no DB).
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { probePooledApiKey } from "./probe";

function okResponse(status: number): Response {
  return {
    ok: true,
    status,
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("probePooledApiKey error policy", () => {
  it("returns ok:true only on a real 2xx", async () => {
    globalThis.fetch = mock(async () => okResponse(200)) as unknown as typeof fetch;

    const result = await probePooledApiKey("openai-api", "sk-valid-key");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("translates a transport failure into a distinguishable status:0 failure — never a fabricated success", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await probePooledApiKey("openai-api", "sk-any-key");

    // The internal failure surfaces as ok:false, NOT silently swallowed into ok:true.
    expect(result.ok).toBe(false);
    // status:0 is the designed "transient / could-not-reach" signal callers use
    // to leave credential health untouched — distinct from a real 401/403.
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("keeps the real HTTP status on a revoked key so it stays distinct from a transient", async () => {
    globalThis.fetch = mock(async () =>
      errorResponse(401, "invalid api key"),
    ) as unknown as typeof fetch;

    const result = await probePooledApiKey("openai-api", "sk-revoked-key");

    expect(result.ok).toBe(false);
    // A revoked key (401) must be distinguishable from a transport failure (0):
    // callers flag needs-reauth only on 401/403, never on a network blip.
    expect(result.status).toBe(401);
    expect(result.error).toContain("401");
    expect(result.error).toContain("invalid api key");
  });

  it("does not let a failed error-body read clobber the load-bearing HTTP status", async () => {
    const bodyReadFails = {
      ok: false,
      status: 403,
      text: async () => {
        throw new Error("stream already consumed");
      },
    } as unknown as Response;
    globalThis.fetch = mock(async () => bodyReadFails) as unknown as typeof fetch;

    const result = await probePooledApiKey("openai-api", "sk-forbidden-key");

    expect(result.ok).toBe(false);
    // The inner `.catch(() => "")` on response.text() must preserve status 403,
    // not fall through to the outer catch (which would report status:0).
    expect(result.status).toBe(403);
  });

  it("distinguishes all three outcomes from one another", async () => {
    const valid = { ...okResponse(200) };
    globalThis.fetch = mock()
      .mockResolvedValueOnce(valid)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(errorResponse(403, "forbidden")) as unknown as typeof fetch;

    const healthy = await probePooledApiKey("openai-api", "k1");
    const transient = await probePooledApiKey("openai-api", "k2");
    const revoked = await probePooledApiKey("openai-api", "k3");

    expect(healthy.ok).toBe(true);
    expect(transient).toMatchObject({ ok: false, status: 0 });
    expect(revoked).toMatchObject({ ok: false, status: 403 });
    // The three renders are mutually distinct — a broken pipeline never reads as
    // healthy, and a transient never reads as a revoked key.
    expect(new Set([healthy.status, transient.status, revoked.status]).size).toBe(3);
  });
});
