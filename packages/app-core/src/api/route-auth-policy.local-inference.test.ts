/**
 * Integration-focused auth contract for local speech compat routes. It drives
 * the real app-core cookie parser and role resolver with deterministic auth
 * store primitives, proving a valid browser session is checked exactly once at
 * the host policy boundary before plugin dispatch.
 */
import http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

type LocalInferenceRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState & { requestAuthorizedByHost?: true },
) => Promise<boolean>;

const authMocks = vi.hoisted(() => ({
  findActiveSession: vi.fn(),
  findIdentity: vi.fn(),
  verifyCsrfToken: vi.fn(),
}));

const localInferenceRouteMocks = vi.hoisted(() => ({
  handleLiveDiarizationRoute: vi.fn<LocalInferenceRouteHandler>(
    async () => false,
  ),
  handleLocalInferenceAsrRoute: vi.fn<LocalInferenceRouteHandler>(
    async () => false,
  ),
  handleLocalInferenceCompatRoutes: vi.fn<LocalInferenceRouteHandler>(
    async () => false,
  ),
  handleLocalInferenceTtsRoute: vi.fn<LocalInferenceRouteHandler>(
    async () => false,
  ),
}));

vi.mock("./compat-route-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./compat-route-shared")>()),
  isTrustedLocalRequest: () => false,
}));

vi.mock("./auth/sessions.js", () => ({
  CSRF_HEADER_NAME: "x-eliza-csrf",
  denyOnAuthStoreError: () => () => null,
  findActiveSession: authMocks.findActiveSession,
  verifyCsrfToken: authMocks.verifyCsrfToken,
}));

vi.mock("../services/auth-store.js", () => ({
  AuthStore: class MockAuthStore {
    findIdentity = authMocks.findIdentity;
  },
}));

vi.mock(
  "@elizaos/plugin-local-inference/routes",
  () => localInferenceRouteMocks,
);

import {
  enforceCompatRouteAuthPolicy,
  resolveCompatRouteAuthPolicy,
} from "./route-auth-policy";
import { handleElizaCompatRoute } from "./server";

const STATE = {
  current: { adapter: { db: {} } },
  pendingAgentName: null,
  pendingRestartReasons: [],
} as unknown as CompatRuntimeState;

function sessionReq(
  pathname: string,
  options: { method?: string; csrf?: string } = {},
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = options.method ?? "GET";
  req.url = pathname;
  req.headers = {
    host: "dashboard.example.test",
    cookie: "eliza_session=valid-host-session",
    ...(options.csrf ? { "x-eliza-csrf": options.csrf } : {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "203.0.113.9",
    configurable: true,
  });
  return req;
}

function fakeRes(): http.ServerResponse {
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.end = (() => res) as typeof res.end;
  return res;
}

describe("local speech host-session auth handoff", () => {
  beforeEach(() => {
    authMocks.findActiveSession.mockReset();
    authMocks.findIdentity.mockReset();
    authMocks.verifyCsrfToken.mockReset();
    for (const handler of Object.values(localInferenceRouteMocks)) {
      handler.mockClear();
    }
    authMocks.findActiveSession.mockResolvedValue({
      identityId: "owner-identity",
    });
    authMocks.findIdentity.mockResolvedValue({ kind: "owner" });
    authMocks.verifyCsrfToken.mockReturnValue(false);
  });

  it("authorizes a valid browser cookie once at the session-tier host boundary", async () => {
    const pathname = "/api/tts/local-inference/status";
    expect(resolveCompatRouteAuthPolicy("GET", pathname)).toMatchObject({
      id: "tts.local-inference",
      tier: "session",
    });

    const req = sessionReq(pathname);
    const res = fakeRes();
    await expect(
      enforceCompatRouteAuthPolicy(req, res, STATE, "GET", pathname),
    ).resolves.toBe("allowed");

    expect(authMocks.findActiveSession).toHaveBeenCalledOnce();
    expect(authMocks.findActiveSession).toHaveBeenCalledWith(
      expect.anything(),
      "valid-host-session",
      undefined,
    );
    expect(authMocks.findIdentity).toHaveBeenCalledOnce();
    expect(authMocks.findIdentity).toHaveBeenCalledWith("owner-identity");
    expect(res.statusCode).toBe(200);
  });

  it.each([
    [
      "TTS with missing CSRF",
      "/api/tts/local-inference",
      "handleLocalInferenceTtsRoute",
      undefined,
    ],
    [
      "TTS with invalid CSRF",
      "/api/tts/local-inference",
      "handleLocalInferenceTtsRoute",
      "invalid-csrf",
    ],
    [
      "ASR with missing CSRF",
      "/api/asr/local-inference",
      "handleLocalInferenceAsrRoute",
      undefined,
    ],
    [
      "ASR with invalid CSRF",
      "/api/asr/local-inference",
      "handleLocalInferenceAsrRoute",
      "invalid-csrf",
    ],
  ] as const)(
    "denies %s before plugin dispatch",
    async (_label, pathname, handlerName, csrf) => {
      const res = fakeRes();

      await expect(
        handleElizaCompatRoute(
          sessionReq(pathname, {
            method: "POST",
            ...(csrf ? { csrf } : {}),
          }),
          res,
          STATE,
        ),
      ).resolves.toBe(true);

      expect(res.statusCode).toBe(403);
      expect(localInferenceRouteMocks[handlerName]).not.toHaveBeenCalled();
      expect(authMocks.verifyCsrfToken).toHaveBeenCalledOnce();
    },
  );

  it("denies a paired machine session before an owner-only model mutation", async () => {
    authMocks.findIdentity.mockResolvedValue({ kind: "machine" });
    authMocks.verifyCsrfToken.mockReturnValue(true);
    const res = fakeRes();

    await expect(
      handleElizaCompatRoute(
        sessionReq("/api/local-inference/active", {
          method: "POST",
          csrf: "valid-csrf",
        }),
        res,
        STATE,
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(403);
    expect(authMocks.findActiveSession).toHaveBeenCalledOnce();
    expect(authMocks.findIdentity).toHaveBeenCalledOnce();
    expect(authMocks.verifyCsrfToken).toHaveBeenCalledOnce();
    expect(
      localInferenceRouteMocks.handleLocalInferenceCompatRoutes,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ["TTS", "/api/tts/local-inference", "handleLocalInferenceTtsRoute"],
    ["ASR", "/api/asr/local-inference", "handleLocalInferenceAsrRoute"],
  ] as const)(
    "mints the host handoff for %s POST only after cookie and CSRF validation",
    async (_label, pathname, handlerName) => {
      authMocks.verifyCsrfToken.mockReturnValue(true);
      localInferenceRouteMocks[handlerName].mockImplementationOnce(
        async (_req, res, state) => {
          expect(state.requestAuthorizedByHost).toBe(true);
          res.statusCode = 204;
          res.end();
          return true;
        },
      );
      const res = fakeRes();

      await expect(
        handleElizaCompatRoute(
          sessionReq(pathname, { method: "POST", csrf: "valid-csrf" }),
          res,
          STATE,
        ),
      ).resolves.toBe(true);

      expect(res.statusCode).toBe(204);
      expect(authMocks.findActiveSession).toHaveBeenCalledOnce();
      expect(authMocks.findIdentity).toHaveBeenCalledOnce();
      expect(authMocks.verifyCsrfToken).toHaveBeenCalledOnce();
      expect(localInferenceRouteMocks[handlerName]).toHaveBeenCalledOnce();
    },
  );
});
