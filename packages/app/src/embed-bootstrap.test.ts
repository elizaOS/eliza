/**
 * Tests for the `/embed` bootstrap handshake (`isEmbedPath` + `runEmbedHandshake`)
 * that authenticates Telegram Mini App / Discord Activity embeds: it detects the
 * platform (explicit `?platform=` or auto-detected from injected Telegram
 * initData or a Discord `?code=` redirect), POSTs the signed launch payload to
 * `<base>/api/embed/auth`, and installs the returned token on the client. The
 * client, fetch, and window are injected fakes; the suite drives the real
 * handshake and asserts it fails closed (no token installed) on unknown
 * platform, missing payload/OAuth state, non-2xx responses, token-less bodies,
 * network errors, and timeouts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type EmbedClient,
  isEmbedPath,
  runEmbedHandshake,
} from "./embed-bootstrap";

const BASE = "https://agent.example";

function fakeClient() {
  const setToken = vi.fn<(token: string | null) => void>();
  const client: EmbedClient = { getBaseUrl: () => BASE, setToken };
  return { client, setToken };
}

function fakeFetch(response: Response | Error) {
  return vi.fn((_url: string, _init?: RequestInit): Promise<Response> => {
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
}

function fakeWin(
  pathname: string,
  search = "",
  telegramInitData?: string,
): Window {
  return {
    location: { pathname, search },
    ...(telegramInitData !== undefined
      ? { Telegram: { WebApp: { initData: telegramInitData, ready: vi.fn() } } }
      : {}),
  } as unknown as Window;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("isEmbedPath", () => {
  it("matches /embed and subpaths only", () => {
    expect(isEmbedPath("/embed")).toBe(true);
    expect(isEmbedPath("/embed/telegram")).toBe(true);
    expect(isEmbedPath("/")).toBe(false);
    expect(isEmbedPath("/embedded")).toBe(false);
  });
});

describe("runEmbedHandshake", () => {
  it("is a no-op off the /embed route", async () => {
    const fetchImpl = fakeFetch(jsonResponse(200, {}));
    const { client, setToken } = fakeClient();
    const outcome = await runEmbedHandshake({
      win: fakeWin("/"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({ status: "not-embed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown platform", async () => {
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=slack"),
      client: fakeClient().client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "unknown_platform" });
  });

  it("fails when the telegram initData is missing", async () => {
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram"),
      client: fakeClient().client,
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "missing_launch_payload",
    });
  });

  it("exchanges a telegram initData payload and installs the token", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, {
        entityId: "e1",
        role: "OWNER",
        adminMode: true,
        token: "embed-token-abc",
      }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin(
        "/embed",
        "?platform=telegram&accountId=acct-1",
        "tg-init-data",
      ),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({
      status: "authenticated",
      role: "OWNER",
      adminMode: true,
    });
    expect(setToken).toHaveBeenCalledWith("embed-token-abc");
    // POSTs the verified launch to the agent's embed-auth route.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/embed/auth`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      platform: "telegram",
      signedLaunchPayload: "tg-init-data",
      accountId: "acct-1",
    });
  });

  it("exchanges a discord Activity code from the query string", async () => {
    const { client } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, { role: "ADMIN", adminMode: true, token: "t" }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin(
        "/embed",
        "?platform=discord&code=oauth2-code&state=signed-state",
      ),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome.status).toBe("authenticated");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      platform: "discord",
      signedLaunchPayload: "oauth2-code",
      state: "signed-state",
    });
  });

  it("auto-detects telegram from injected initData on a bare /embed URL", async () => {
    // The Telegram web_app button links to a bare `<base>/embed` (no ?platform).
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, { role: "OWNER", adminMode: true, token: "tok" }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "", "tg-init"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome.status).toBe("authenticated");
    expect(setToken).toHaveBeenCalledWith("tok");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      platform: "telegram",
      signedLaunchPayload: "tg-init",
    });
  });

  it("auto-detects discord from a bare /embed?code= redirect", async () => {
    const { client } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, { role: "ADMIN", adminMode: true, token: "t" }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?code=disc-code&state=signed-state"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome.status).toBe("authenticated");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      platform: "discord",
      signedLaunchPayload: "disc-code",
      state: "signed-state",
    });
  });

  it("fails closed when a discord redirect has a code but omits OAuth state", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, { role: "ADMIN", adminMode: true, token: "t" }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?code=disc-code"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "missing_oauth_state",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed on a bare /embed with no platform signal at all", async () => {
    const { client } = fakeClient();
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed"),
      client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "unknown_platform" });
  });

  it("fails closed on a 403 without installing a token", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(jsonResponse(403, { error: "nope" }));
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram", "tg"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "http_403" });
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed when the response carries no token", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(jsonResponse(200, { role: "OWNER" }));
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram", "tg"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "no_token" });
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed when the fetch rejects", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(new Error("network down"));
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram", "tg"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "network_error" });
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed when the auth request times out", async () => {
    vi.useFakeTimers();
    try {
      const { client, setToken } = fakeClient();
      const fetchImpl = vi.fn(
        (_url: string, _init?: RequestInit) => new Promise<Response>(() => {}),
      );
      const outcomePromise = runEmbedHandshake({
        win: fakeWin("/embed", "?platform=telegram", "tg"),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        client,
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(outcomePromise).resolves.toEqual({
        status: "failed",
        reason: "network_timeout",
      });
      expect(setToken).not.toHaveBeenCalled();
      expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });
});
