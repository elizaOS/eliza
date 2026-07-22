// @vitest-environment jsdom

/**
 * Auth endpoint contract coverage for success, rejection, and malformed
 * responses. The HTTP and desktop transports are deterministic boundaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import {
  authChangePassword,
  authListSessions,
  authLoginPassword,
  authLogout,
  authMe,
  authRevokeSession,
  authSetup,
} from "./auth-client";

const transportMock = vi.hoisted(() => ({
  fetchWithCsrf: vi.fn(),
}));

const desktopBridgeMock = vi.hoisted(() => ({
  invokeDesktopBridgeRequest: vi.fn<(request: unknown) => Promise<unknown>>(
    async () => null,
  ),
}));

vi.mock("./csrf-client", () => transportMock);
vi.mock("../bridge/electrobun-rpc", () => desktopBridgeMock);

const identity = {
  id: "owner-1",
  displayName: "Owner",
  kind: "owner" as const,
};
const session = {
  id: "session-1",
  kind: "browser" as const,
  expiresAt: null,
};
const access = {
  mode: "session" as const,
  passwordConfigured: true,
  ownerConfigured: true,
};

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("auth endpoint client", () => {
  beforeEach(() => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      apiBase: "https://agent.example.test",
    });
    transportMock.fetchWithCsrf.mockReset();
    desktopBridgeMock.invokeDesktopBridgeRequest.mockReset();
    desktopBridgeMock.invokeDesktopBridgeRequest.mockResolvedValue(null);
  });

  afterEach(() => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.restoreAllMocks();
  });

  it("returns typed success values across setup, login, session, and password endpoints", async () => {
    transportMock.fetchWithCsrf
      .mockResolvedValueOnce(
        jsonResponse(200, { identity, session, csrfToken: "csrf-setup" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { identity, session, csrfToken: "csrf-login" }),
      )
      .mockResolvedValueOnce(jsonResponse(204))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          sessions: [
            {
              ...session,
              ip: null,
              userAgent: null,
              lastSeenAt: 1,
              current: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(204))
      .mockResolvedValueOnce(jsonResponse(204));

    await expect(
      authSetup({ displayName: "Owner", password: "correct horse battery" }),
    ).resolves.toMatchObject({ ok: true, csrfToken: "csrf-setup" });
    await expect(
      authLoginPassword({
        displayName: "Owner",
        password: "correct horse battery",
        rememberDevice: true,
      }),
    ).resolves.toMatchObject({ ok: true, csrfToken: "csrf-login" });
    await expect(authLogout()).resolves.toEqual({ ok: true });
    await expect(authListSessions()).resolves.toMatchObject({
      ok: true,
      sessions: [expect.objectContaining({ id: "session-1", current: true })],
    });
    await expect(authRevokeSession("session-1")).resolves.toEqual({ ok: true });
    await expect(
      authChangePassword({ newPassword: "new correct horse battery" }),
    ).resolves.toEqual({ ok: true });

    expect(transportMock.fetchWithCsrf.mock.calls.map(([url]) => url)).toEqual([
      "https://agent.example.test/api/auth/setup",
      "https://agent.example.test/api/auth/login/password",
      "https://agent.example.test/api/auth/logout",
      "https://agent.example.test/api/auth/sessions",
      "https://agent.example.test/api/auth/sessions/session-1/revoke",
      "https://agent.example.test/api/auth/password/change",
    ]);
  });

  it("maps setup and login rejection shapes to actionable client reasons", async () => {
    transportMock.fetchWithCsrf
      .mockResolvedValueOnce(jsonResponse(409, {}))
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(400, { reason: "weak_password" }))
      .mockResolvedValueOnce(jsonResponse(400, { reason: "bad_name" }))
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(429, {}));

    await expect(
      authSetup({ displayName: "Owner", password: "password" }),
    ).resolves.toMatchObject({ ok: false, reason: "already_initialized" });
    await expect(
      authSetup({ displayName: "Owner", password: "password" }),
    ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    await expect(
      authSetup({ displayName: "Owner", password: "password" }),
    ).resolves.toMatchObject({ ok: false, reason: "weak_password" });
    await expect(
      authSetup({ displayName: "", password: "password" }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_display_name" });
    await expect(
      authLoginPassword({ displayName: "Owner", password: "wrong" }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_credentials" });
    await expect(
      authLoginPassword({ displayName: "Owner", password: "wrong" }),
    ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("fails auth-me closed for malformed success bodies and preserves authoritative 401 reasons", async () => {
    transportMock.fetchWithCsrf
      .mockResolvedValueOnce(
        new Response("<!doctype html><title>Eliza</title>", { status: 200 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { access }))
      .mockResolvedValueOnce(
        jsonResponse(401, {
          reason: "remote_auth_required",
          access,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { identity, session, access }));

    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 503,
      reason: "server_error",
    });
    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 503,
      reason: "server_error",
    });
    await expect(authMe()).resolves.toMatchObject({
      ok: false,
      status: 401,
      reason: "remote_auth_required",
      access,
    });
    await expect(authMe()).resolves.toEqual({
      ok: true,
      identity,
      session,
      access,
    });
  });

  it("uses desktop snapshots and direct shared-Cloud identity without an HTTP probe", async () => {
    desktopBridgeMock.invokeDesktopBridgeRequest.mockResolvedValueOnce({
      identity,
      session,
    });

    await expect(authMe()).resolves.toMatchObject({
      ok: true,
      identity,
      session,
      access,
    });

    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent-1",
    });
    await expect(authMe()).resolves.toMatchObject({
      ok: true,
      identity: { id: "cloud", kind: "machine" },
      session: { id: "cloud", kind: "machine" },
    });
    expect(transportMock.fetchWithCsrf).not.toHaveBeenCalled();
  });

  it("keeps logout best-effort while session and password mutations report failures", async () => {
    transportMock.fetchWithCsrf
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(400, { reason: "weak_password" }))
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(429, {}));

    await expect(authLogout()).resolves.toEqual({ ok: true });
    await expect(authListSessions()).resolves.toEqual({
      ok: false,
      status: 401,
    });
    await expect(authListSessions()).resolves.toEqual({
      ok: false,
      status: 503,
    });
    await expect(authRevokeSession("missing")).resolves.toEqual({
      ok: false,
      status: 404,
    });
    await expect(authRevokeSession("forbidden")).resolves.toEqual({
      ok: false,
      status: 401,
    });
    await expect(authRevokeSession("failed")).resolves.toEqual({
      ok: false,
      status: 500,
    });
    await expect(
      authChangePassword({ newPassword: "weak" }),
    ).resolves.toMatchObject({ ok: false, reason: "weak_password" });
    await expect(
      authChangePassword({ newPassword: "new password" }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_credentials" });
    await expect(
      authChangePassword({ newPassword: "new password" }),
    ).resolves.toMatchObject({ ok: false, reason: "owner_not_found" });
    await expect(
      authChangePassword({ newPassword: "new password" }),
    ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
  });
});
