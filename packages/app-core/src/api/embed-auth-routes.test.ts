/**
 * Route tests for handleEmbedAuthRoutes (POST /api/embed/auth): a platform
 * launch handshake (Telegram/Discord, dependency-injected verifyEmbedLaunch) is
 * validated and, on success, minted into a scoped embed-session token that the
 * compat API auth gate accepts through the same reader. Covers the 503/400/403
 * fail-closed paths and env-only vs runtime-only signing-secret sources.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStore } from "../services/auth-store";
import { ensureCompatApiAuthorizedAsync } from "./auth";
import { verifyEmbedSessionToken } from "./auth/embed-session-token";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleEmbedAuthRoutes } from "./embed-auth-routes";

const EMBED_SECRET = "embed-secret-at-least-16-chars";
const EMBED_ENTITY_ID = "11111111-1111-1111-1111-111111111111";

// No module mocks: both collaborators are supplied directly. The request body
// is delivered as the pre-parsed `req.body` the rawPath plugin-route adapter
// attaches in production (readCompatJsonBody honours it), and verifyEmbedLaunch
// is dependency-injected. Module mocks (vi.mock) race under app-core's vmForks
// pool at full-suite parallelism, which previously hung/failed this file.
const verifyEmbedLaunch = vi.fn();

const noSessionStore = {
  findSession: async () => null,
  findIdentity: async () => null,
} as unknown as AuthStore;

function fakeRes() {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body: () => (bodyText.length > 0 ? JSON.parse(bodyText) : null),
    status: () => res.statusCode,
  };
}

function fakeReq(
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "example.com" };
  if (body !== undefined) {
    (req as http.IncomingMessage & { body?: unknown }).body = body;
  }
  return req;
}

function authReq(token: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.headers = {
    host: "localhost:2138",
    "x-forwarded-for": "203.0.113.9",
    authorization: `Bearer ${token}`,
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "203.0.113.9",
    configurable: true,
  });
  return req;
}

const runtimeState = (current: unknown): CompatRuntimeState =>
  ({
    current,
    pendingAgentName: null,
    pendingRestartReasons: [],
  }) as CompatRuntimeState;

const call = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
) =>
  handleEmbedAuthRoutes(req, res, state, {
    verifyEmbedLaunch: verifyEmbedLaunch as never,
  });

beforeEach(() => {
  verifyEmbedLaunch.mockReset();
  delete process.env.ELIZA_EMBED_SESSION_SECRET;
  delete process.env.ELIZA_API_TOKEN;
});

afterEach(() => {
  delete process.env.ELIZA_EMBED_SESSION_SECRET;
  delete process.env.ELIZA_API_TOKEN;
});

describe("handleEmbedAuthRoutes", () => {
  it("ignores non-matching method/path (returns false)", async () => {
    const { res } = fakeRes();
    const handled = await call(
      fakeReq("GET", "/api/embed/auth"),
      res,
      runtimeState({}),
    );
    expect(handled).toBe(false);
    expect(verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("503 when the agent runtime is not available", async () => {
    const r = fakeRes();
    const handled = await call(
      fakeReq("POST", "/api/embed/auth"),
      r.res,
      runtimeState(null),
    );
    expect(handled).toBe(true);
    expect(r.status()).toBe(503);
    expect(verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("400 on missing/invalid input (verify never called)", async () => {
    const r = fakeRes();
    await call(
      fakeReq("POST", "/api/embed/auth", { platform: "telegram" }),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(400);
    expect(verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("400 on an unknown platform", async () => {
    const r = fakeRes();
    await call(
      fakeReq("POST", "/api/embed/auth", {
        platform: "slack",
        signedLaunchPayload: "x",
      }),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(400);
    expect(verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("403 (fail closed) when the handshake rejects", async () => {
    verifyEmbedLaunch.mockResolvedValue({
      ok: false,
      status: 403,
      reason: "telegram_bad_signature",
    });
    const r = fakeRes();
    await call(
      fakeReq("POST", "/api/embed/auth", {
        platform: "telegram",
        signedLaunchPayload: "forged",
      }),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(403);
    expect(verifyEmbedLaunch).toHaveBeenCalledTimes(1);
  });

  it("200 with the verified principal on success", async () => {
    verifyEmbedLaunch.mockResolvedValue({
      ok: true,
      entityId: EMBED_ENTITY_ID,
      role: "OWNER",
      adminMode: true,
    });
    const runtime = {
      agentId: "agent",
      getSetting: (k: string) =>
        k === "ELIZA_EMBED_SESSION_SECRET" ? EMBED_SECRET : undefined,
    };
    const r = fakeRes();
    await call(
      fakeReq("POST", "/api/embed/auth", {
        platform: "telegram",
        signedLaunchPayload: "valid",
        accountId: "acct-1",
      }),
      r.res,
      runtimeState(runtime),
    );
    expect(r.status()).toBe(200);
    const body = r.body() as {
      entityId: string;
      role: string;
      adminMode: boolean;
      token: string;
      expiresAt: number;
    };
    expect(body).toMatchObject({
      entityId: EMBED_ENTITY_ID,
      role: "OWNER",
      adminMode: true,
    });
    // The minted scoped token round-trips to the same verified principal.
    expect(typeof body.token).toBe("string");
    const decoded = verifyEmbedSessionToken(body.token, EMBED_SECRET);
    expect(decoded?.entityId).toBe(EMBED_ENTITY_ID);
    expect(decoded?.role).toBe("OWNER");
    // The handshake is called with the live runtime + the parsed input.
    expect(verifyEmbedLaunch).toHaveBeenCalledWith(
      {
        platform: "telegram",
        signedLaunchPayload: "valid",
        accountId: "acct-1",
      },
      runtime,
    );
  });

  it("returns a null token when no signing secret is configured", async () => {
    verifyEmbedLaunch.mockResolvedValue({
      ok: true,
      entityId: "22222222-2222-2222-2222-222222222222",
      role: "ADMIN",
      adminMode: true,
    });
    const r = fakeRes();
    await call(
      fakeReq("POST", "/api/embed/auth", {
        platform: "telegram",
        signedLaunchPayload: "valid",
      }),
      r.res,
      runtimeState({ agentId: "agent", getSetting: () => undefined }),
    );
    expect(r.status()).toBe(200);
    expect((r.body() as { token: unknown }).token).toBeNull();
  });

  it("mints an env-only token that the API auth gate accepts", async () => {
    process.env.ELIZA_EMBED_SESSION_SECRET = EMBED_SECRET;
    verifyEmbedLaunch.mockResolvedValue({
      ok: true,
      entityId: EMBED_ENTITY_ID,
      role: "OWNER",
      adminMode: true,
    });
    const runtime = {
      agentId: "agent",
      getSetting: () => undefined,
    };
    const r = fakeRes();
    await call(
      fakeReq("POST", "/api/embed/auth", {
        platform: "telegram",
        signedLaunchPayload: "valid",
      }),
      r.res,
      runtimeState(runtime),
    );

    const body = r.body() as { token: string; expiresAt: number };
    expect(typeof body.token).toBe("string");
    const ok = await ensureCompatApiAuthorizedAsync(
      authReq(body.token),
      fakeRes().res,
      { store: noSessionStore, now: body.expiresAt - 1 },
    );
    expect(ok).toBe(true);
  });

  it("mints a runtime-only token that the API auth gate accepts through the same reader", async () => {
    verifyEmbedLaunch.mockResolvedValue({
      ok: true,
      entityId: EMBED_ENTITY_ID,
      role: "OWNER",
      adminMode: true,
    });
    const runtime = {
      agentId: "agent",
      getSetting: (key: string) =>
        key === "ELIZA_EMBED_SESSION_SECRET" ? EMBED_SECRET : undefined,
    };
    const r = fakeRes();
    await call(
      fakeReq("POST", "/api/embed/auth", {
        platform: "telegram",
        signedLaunchPayload: "valid",
      }),
      r.res,
      runtimeState(runtime),
    );

    const body = r.body() as { token: string; expiresAt: number };
    expect(typeof body.token).toBe("string");
    const ok = await ensureCompatApiAuthorizedAsync(
      authReq(body.token),
      fakeRes().res,
      {
        store: noSessionStore,
        now: body.expiresAt - 1,
        readSetting: runtime.getSetting,
      },
    );
    expect(ok).toBe(true);
  });

  it("wires the resolved Discord exchange into the handshake for discord", async () => {
    verifyEmbedLaunch.mockResolvedValue({
      ok: false,
      status: 403,
      reason: "x",
    });
    const exchangeFn = vi.fn();
    const resolveDiscordExchange = vi.fn(() => exchangeFn);
    const runtime = { agentId: "agent", getSetting: () => undefined };
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth", {
        platform: "discord",
        signedLaunchPayload: "oauth2-code",
        accountId: "acct-9",
      }),
      r.res,
      runtimeState(runtime),
      {
        verifyEmbedLaunch: verifyEmbedLaunch as never,
        resolveDiscordExchange: resolveDiscordExchange as never,
      },
    );
    expect(resolveDiscordExchange).toHaveBeenCalledWith(runtime);
    expect(verifyEmbedLaunch).toHaveBeenCalledWith(
      {
        platform: "discord",
        signedLaunchPayload: "oauth2-code",
        accountId: "acct-9",
        discordExchange: exchangeFn,
      },
      runtime,
    );
  });

  it("passes an undefined exchange for discord when credentials are unconfigured", async () => {
    verifyEmbedLaunch.mockResolvedValue({
      ok: false,
      status: 403,
      reason: "x",
    });
    const resolveDiscordExchange = vi.fn(() => undefined);
    const runtime = { agentId: "agent", getSetting: () => undefined };
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth", {
        platform: "discord",
        signedLaunchPayload: "oauth2-code",
      }),
      r.res,
      runtimeState(runtime),
      {
        verifyEmbedLaunch: verifyEmbedLaunch as never,
        resolveDiscordExchange: resolveDiscordExchange as never,
      },
    );
    const input = verifyEmbedLaunch.mock.calls[0]?.[0] as {
      platform: string;
      discordExchange: unknown;
    };
    expect(input.platform).toBe("discord");
    expect(input.discordExchange).toBeUndefined();
  });

  it("never resolves a Discord exchange for a telegram launch", async () => {
    verifyEmbedLaunch.mockResolvedValue({
      ok: false,
      status: 403,
      reason: "x",
    });
    const resolveDiscordExchange = vi.fn(() => vi.fn());
    const runtime = { agentId: "agent", getSetting: () => undefined };
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth", {
        platform: "telegram",
        signedLaunchPayload: "initData",
      }),
      r.res,
      runtimeState(runtime),
      {
        verifyEmbedLaunch: verifyEmbedLaunch as never,
        resolveDiscordExchange: resolveDiscordExchange as never,
      },
    );
    expect(resolveDiscordExchange).not.toHaveBeenCalled();
    const input = verifyEmbedLaunch.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(input).not.toHaveProperty("discordExchange");
  });
});
