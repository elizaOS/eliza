import * as http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const mocks = vi.hoisted(() => ({
  verifyEmbedLaunch: vi.fn(),
}));

vi.mock("./auth/embed-handshake", () => ({
  verifyEmbedLaunch: mocks.verifyEmbedLaunch,
}));

import { handleEmbedAuthRoutes } from "./embed-auth-routes";

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

// The route runs behind the runtime's plugin-route adapter (rawPath: true),
// which pre-parses the JSON body and attaches it as `req.body`. Mirror that here
// by setting `req.body` rather than mocking the body reader — the real
// `readCompatJsonBody` honours the pre-parsed body and returns it synchronously,
// so the test never depends on streaming a (never-ending) fake socket.
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

const runtimeState = (current: unknown): CompatRuntimeState =>
  ({
    current,
    pendingAgentName: null,
    pendingRestartReasons: [],
  }) as CompatRuntimeState;

beforeEach(() => {
  mocks.verifyEmbedLaunch.mockReset();
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
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth", { platform: "telegram" }),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(400);
    expect(mocks.verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("400 on an unknown platform", async () => {
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth", {
        platform: "slack",
        signedLaunchPayload: "x",
      }),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(400);
    expect(mocks.verifyEmbedLaunch).not.toHaveBeenCalled();
  });

  it("403 (fail closed) when the handshake rejects", async () => {
    mocks.verifyEmbedLaunch.mockResolvedValue({
      ok: false,
      status: 403,
      reason: "telegram_bad_signature",
    });
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth", {
        platform: "telegram",
        signedLaunchPayload: "forged",
      }),
      r.res,
      runtimeState({}),
    );
    expect(r.status()).toBe(403);
    expect(mocks.verifyEmbedLaunch).toHaveBeenCalledTimes(1);
  });

  it("200 with the verified principal on success", async () => {
    mocks.verifyEmbedLaunch.mockResolvedValue({
      ok: true,
      entityId: "11111111-1111-1111-1111-111111111111",
      role: "OWNER",
      adminMode: true,
    });
    const runtime = { agentId: "agent" };
    const r = fakeRes();
    await handleEmbedAuthRoutes(
      fakeReq("POST", "/api/embed/auth", {
        platform: "telegram",
        signedLaunchPayload: "valid",
        accountId: "acct-1",
      }),
      r.res,
      runtimeState(runtime),
    );
    expect(r.status()).toBe(200);
    expect(r.body()).toMatchObject({
      entityId: "11111111-1111-1111-1111-111111111111",
      role: "OWNER",
      adminMode: true,
    });
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
});
