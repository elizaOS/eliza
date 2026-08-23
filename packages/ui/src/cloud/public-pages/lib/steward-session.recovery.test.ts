/**
 * Verifies login-page cookie-session recovery without reading HttpOnly tokens:
 * one rejected refresh may lose a rotation race, while two rejected refreshes
 * clear the stale server session before the user starts a new login.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoverStewardEmailSessionViaCookie,
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

function tokenForEmail(email: string): string {
  const payload = btoa(JSON.stringify({ email }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${payload}.signature`;
}

describe("recoverStewardEmailSessionViaCookie", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("never deletes a stale marker session whose refresh cookie stays expired", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          { error: "Refresh token rejected", code: "invalid_token" },
          401,
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const recovery = recoverStewardEmailSessionViaCookie("person@example.com", {
      intervalMs: 100,
      timeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(recovery).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === "POST"),
    ).toBe(true);
  });

  it("accepts the challenged account when its cookie arrives after two rejected refreshes", async () => {
    vi.useFakeTimers();
    const expectedToken = tokenForEmail("person@example.com");
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, token: expectedToken }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "Refresh token rejected", code: "invalid_token" },
          401,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "Refresh token rejected", code: "missing_token" },
          401,
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const recovery = recoverStewardEmailSessionViaCookie("person@example.com", {
      intervalMs: 100,
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(recovery).resolves.toEqual({ ok: true, token: expectedToken });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === "POST"),
    ).toBe(true);
  });

  it("cancels an in-flight refresh when the caller aborts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    const recovery = recoverStewardEmailSessionViaCookie("person@example.com", {
      signal: controller.signal,
      intervalMs: 100,
      timeoutMs: 10_000,
    });

    controller.abort();

    await expect(recovery).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abandons a hung refresh at the recovery deadline and clears its timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const recovery = recoverStewardEmailSessionViaCookie("person@example.com", {
      intervalMs: 100,
      timeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(recovery).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null without fetching for an already-aborted caller signal", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, token: tokenForEmail("person@example.com") }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    await expect(
      recoverStewardEmailSessionViaCookie("person@example.com", {
        signal: controller.signal,
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a session that resolves only after the caller aborted", async () => {
    vi.useFakeTimers();
    let releaseFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    const recovery = recoverStewardEmailSessionViaCookie("person@example.com", {
      signal: controller.signal,
      intervalMs: 100,
      timeoutMs: 10_000,
    });

    controller.abort();
    releaseFetch?.(
      jsonResponse({ ok: true, token: tokenForEmail("person@example.com") }),
    );

    await expect(recovery).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept another account before the challenged session arrives", async () => {
    vi.useFakeTimers();
    const otherToken = tokenForEmail("other@example.com");
    const expectedToken = tokenForEmail("person@example.com");
    const fetchMock = vi
      .fn(async () => jsonResponse({ ok: true, token: expectedToken }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, token: otherToken }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const recovery = recoverStewardEmailSessionViaCookie(
      " PERSON@example.com ",
      { intervalMs: 100, timeoutMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(recovery).resolves.toEqual({ ok: true, token: expectedToken });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

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
      headers: expect.objectContaining({ "X-Eliza-CSRF": "1" }),
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
