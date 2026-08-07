/**
 * Verifies login-page cookie-session recovery without reading HttpOnly tokens:
 * one rejected refresh may lose a rotation race, while two rejected refreshes
 * clear the stale server session before the user starts a new login.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoverStewardSessionViaCookie,
  refreshStewardSessionViaCookie,
} from "./steward-session";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("recoverStewardSessionViaCookie", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the first healthy refresh without clearing the session", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, token: "fresh-token" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(recoverStewardSessionViaCookie()).resolves.toEqual({
      ok: true,
      token: "fresh-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("retries once when another tab may have won refresh-token rotation", async () => {
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "Refresh token rejected", code: "invalid_token" },
          401,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, token: "winner-token" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(recoverStewardSessionViaCookie()).resolves.toEqual({
      ok: true,
      token: "winner-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === "POST"),
    ).toBe(true);
  });

  it("clears a dead cookie session after two rejected refreshes", async () => {
    const rejected = () =>
      jsonResponse(
        { error: "Refresh token rejected", code: "invalid_token" },
        401,
      );
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true }),
      )
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(recoverStewardSessionViaCookie()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "DELETE",
      credentials: "include",
    });
  });

  it("preserves non-auth refresh failures for the login boundary", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          { error: "Steward upstream unavailable", code: "internal_error" },
          502,
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(recoverStewardSessionViaCookie()).rejects.toThrow(
      "Steward upstream unavailable",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("refreshStewardSessionViaCookie", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("still exposes a rejected token as a typed failure to non-recovery callers", async () => {
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          { error: "Refresh token rejected", code: "invalid_token" },
          401,
        ),
    ) as unknown as typeof fetch;

    await expect(refreshStewardSessionViaCookie()).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });
  });
});
