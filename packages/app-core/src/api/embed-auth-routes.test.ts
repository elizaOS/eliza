import * as http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const mocks = vi.hoisted(() => ({
  verifyEmbedLaunch: vi.fn(),
  readCompatJsonBody: vi.fn(),
}));

vi.mock("./auth/embed-handshake", () => ({
  verifyEmbedLaunch: mocks.verifyEmbedLaunch,
}));

vi.mock("./compat-route-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compat-route-shared")>();
  return { ...actual, readCompatJsonBody: mocks.readCompatJsonBody };
});

import { verifyEmbedSessionToken } from "./auth/embed-session-token";
import { handleEmbedAuthRoutes } from "./embed-auth-routes";

const EMBED_SECRET = "embed-secret-at-least-16-chars";

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

function fakeReq(method: string, pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "example.com" };
  return req;
}

const runtimeState = (current: unknown): CompatRuntimeState =>
  ({
    current,
    pendingAgentName: null,
    pendingRestartReasons: [],
  }) as CompatRuntimeState;

beforeEach(() => {
  mocks.verifyEmbedLaunch.mockReset();
  mocks.readCompatJsonBody.mockReset();
});

describe("handleEmbedAuthRoutes", () => {
  it("ignores non-matching method/path (returns false)", async () => {
    const { res } = fakeRes();
    const handled = await handleEmbedAuthRoutes(
      fakeReq("GET", "/api/embed/auth"),
      res,
      runtimeState({}),
    );
    expect(handled).toBe(false);
    expect(mocks.verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("503 when the agent runtime is not available", async () => {
    const r = fakeRes();
    const handled = await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth"),
      r.res,
      runtimeState(null),
    );
    expect(handled).toBe(true);
    expect(r.status()).toBe(503);
    expect(mocks.verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("400 on missing/invalid input (verify never called)", async () => {
    mocks.readCompatJsonBody.mockResolvedValue({ platform: "telegram" });
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth"),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(400);
    expect(mocks.verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("400 on an unknown platform", async () => {
    mocks.readCompatJsonBody.mockResolvedValue({
      platform: "slack",
      signedLaunchPayload: "x",
    });
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth"),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(400);
    expect(mocks.verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("403 (fail closed) when the handshake rejects", async () => {
    mocks.readCompatJsonBody.mockResolvedValue({
      platform: "telegram",
      signedLaunchPayload: "forged",
    });
    mocks.verifyEmbedLaunch.mockResolvedValue({
      ok: false,
      status: 403,
      reason: "telegram_bad_signature",
    });
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth"),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(403);
    expect(mocks.verifyEmbedLaunch).toHaveBeenCalledTimes(1);
  });

  it("200 with the verified principal on success", async () => {
    mocks.readCompatJsonBody.mockResolvedValue({
      platform: "telegram",
      signedLaunchPayload: "valid",
      accountId: "acct-1",
    });
    mocks.verifyEmbedLaunch.mockResolvedValue({
      ok: true,
      entityId: "11111111-1111-1111-1111-111111111111",
      role: "OWNER",
      adminMode: true,
    });
    const runtime = {
      agentId: "agent",
      getSetting: (k: string) =>
        k === "ELIZA_EMBED_SESSION_SECRET" ? EMBED_SECRET : undefined,
    };
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth"),
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
      entityId: "11111111-1111-1111-1111-111111111111",
      role: "OWNER",
      adminMode: true,
    });
    // The minted scoped token round-trips to the same verified principal.
    expect(typeof body.token).toBe("string");
    const decoded = verifyEmbedSessionToken(body.token, EMBED_SECRET);
    expect(decoded?.entityId).toBe("11111111-1111-1111-1111-111111111111");
    expect(decoded?.role).toBe("OWNER");
    // The handshake is called with the live runtime + the parsed input.
    expect(mocks.verifyEmbedLaunch).toHaveBeenCalledWith(
      {
        platform: "telegram",
        signedLaunchPayload: "valid",
        accountId: "acct-1",
      },
      runtime,
    );
  });

  it("returns a null token when no signing secret is configured", async () => {
    mocks.readCompatJsonBody.mockResolvedValue({
      platform: "telegram",
      signedLaunchPayload: "valid",
    });
    mocks.verifyEmbedLaunch.mockResolvedValue({
      ok: true,
      entityId: "22222222-2222-2222-2222-222222222222",
      role: "ADMIN",
      adminMode: true,
    });
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth"),
      r.res,
      runtimeState({ agentId: "agent", getSetting: () => undefined }),
    );
    expect(r.status()).toBe(200);
    expect((r.body() as { token: unknown }).token).toBeNull();
  });
});
