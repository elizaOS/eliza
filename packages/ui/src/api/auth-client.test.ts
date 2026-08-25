/** Verifies the P1 session auth client's endpoint mapping and failure unions through the package's configured test harness. */
// @vitest-environment node

import { getElizaApiToken } from "@elizaos/shared";
import {
  clearStoredStewardToken,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
/**
 * Unit coverage for auth-client.ts. Transport, boot-config, desktop bridge,
 * steward-session storage, and client-cloud seams are mocked; every asserted
 * value is computed by the real module from controlled boundary responses
 * (real `Response` objects), so the discriminated-union mapping is exercised,
 * not restated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { getBootConfig } from "../config/boot-config";
import { clearSharedCloudAccountBinding } from "../state/shared-cloud-account-binding";
import { isManagedCloudSharedAgentBase } from "../utils/cloud-agent-base";
import {
  authChangePassword,
  authListSessions,
  authLoginPassword,
  authLogout,
  authMe,
  authRevokeSession,
  authSetup,
} from "./auth-client";
import {
  cloudTokenSecsRemaining,
  refreshCloudStewardSession,
} from "./client-cloud";
import { fetchWithCsrf } from "./csrf-client";
import { isDesktopExternalApiBaseUrl } from "./desktop-external-api-base";

vi.mock("./csrf-client", () => ({ fetchWithCsrf: vi.fn() }));
vi.mock("../config/boot-config", () => ({ getBootConfig: vi.fn() }));
vi.mock("@elizaos/shared", () => ({ getElizaApiToken: vi.fn() }));
vi.mock("@elizaos/shared/steward-session-client", () => ({
  readStoredStewardToken: vi.fn(),
  writeStoredStewardToken: vi.fn(),
  clearStoredStewardToken: vi.fn(),
  hasStewardAuthedCookie: vi.fn(),
}));
vi.mock("../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: vi.fn(),
}));
vi.mock("../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: vi.fn(),
}));
vi.mock("../platform", () => ({ isNative: false }));
vi.mock("../state/shared-cloud-account-binding", () => ({
  clearSharedCloudAccountBinding: vi.fn(),
}));
vi.mock("../utils/cloud-agent-base", () => ({
  isManagedCloudSharedAgentBase: vi.fn(),
}));
vi.mock("./client-cloud", () => ({
  cloudTokenSecsRemaining: vi.fn(),
  refreshCloudStewardSession: vi.fn(),
}));
vi.mock("./desktop-external-api-base", () => ({
  isDesktopExternalApiBaseUrl: vi.fn(),
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const getBootConfigMock = vi.mocked(getBootConfig);
const getElizaApiTokenMock = vi.mocked(getElizaApiToken);
const readStoredStewardTokenMock = vi.mocked(readStoredStewardToken);
const writeStoredStewardTokenMock = vi.mocked(writeStoredStewardToken);
const clearStoredStewardTokenMock = vi.mocked(clearStoredStewardToken);
const hasStewardAuthedCookieMock = vi.mocked(hasStewardAuthedCookie);
const invokeDesktopBridgeRequestMock = vi.mocked(invokeDesktopBridgeRequest);
const isElectrobunRuntimeMock = vi.mocked(isElectrobunRuntime);
const clearSharedCloudAccountBindingMock = vi.mocked(
  clearSharedCloudAccountBinding,
);
const isManagedCloudSharedAgentBaseMock = vi.mocked(
  isManagedCloudSharedAgentBase,
);
const cloudTokenSecsRemainingMock = vi.mocked(cloudTokenSecsRemaining);
const refreshCloudStewardSessionMock = vi.mocked(refreshCloudStewardSession);
const isDesktopExternalApiBaseUrlMock = vi.mocked(isDesktopExternalApiBaseUrl);

afterEach(() => {
  vi.clearAllMocks();
});

const identity = {
  id: "entity-1",
  displayName: "Owner",
  kind: "owner" as const,
};
const sessionInfo = {
  id: "session-1",
  kind: "browser" as const,
  expiresAt: 1893456000000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("authSetup", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
  });

  it("posts credentials to /api/auth/setup and passes the success payload through", async () => {
    const params = { displayName: "Owner", password: "correct horse battery" };
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ identity, session: sessionInfo, csrfToken: "csrf-1" }),
    );

    const result = await authSetup(params);

    expect(fetchWithCsrfMock).toHaveBeenCalledWith("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    expect(result).toEqual({
      ok: true,
      identity,
      session: sessionInfo,
      csrfToken: "csrf-1",
    });
  });

  it("maps a transport error carrying an Error message onto server_error", async () => {
    fetchWithCsrfMock.mockRejectedValueOnce(new Error("boom"));

    const result = await authSetup({ displayName: "O", password: "p" });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "server_error",
      message: "boom",
    });
  });

  it("uses the generic network message for non-Error transport failures", async () => {
    fetchWithCsrfMock.mockRejectedValueOnce("socket down");

    const result = await authSetup({ displayName: "O", password: "p" });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "server_error",
      message: "Network error",
    });
  });

  it("reports already_initialized on 409 regardless of the response body", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ reason: "whatever" }, 409),
    );

    const result = await authSetup({ displayName: "O", password: "p" });

    expect(result).toEqual({
      ok: false,
      status: 409,
      reason: "already_initialized",
      message: "An owner account already exists.",
    });
  });

  it("reports rate_limited on 429 without reading the body reason", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 429));

    const result = await authSetup({ displayName: "O", password: "p" });

    expect(result).toEqual({
      ok: false,
      status: 429,
      reason: "rate_limited",
      message: "Too many attempts — wait a moment and try again.",
    });
  });

  it("maps a 400 whose body reason is weak_password onto weak_password", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ reason: "weak_password" }, 400),
    );

    const result = await authSetup({ displayName: "O", password: "short" });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: "weak_password",
      message:
        "Password too weak. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    });
  });

  it("treats any other 400 as an invalid display name", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ reason: "something_else" }, 400),
    );

    const result = await authSetup({ displayName: "", password: "p" });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: "invalid_display_name",
      message:
        "Display name must be 1–64 characters (letters, numbers, spaces, _ . - @).",
    });
  });

  it("falls back to invalid_display_name when a 400 body is not parseable JSON", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("<html>", 400));

    const result = await authSetup({ displayName: "", password: "p" });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      reason: "invalid_display_name",
    });
  });

  it("maps unexpected non-ok statuses onto server_error with the status embedded", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 503));

    const result = await authSetup({ displayName: "O", password: "p" });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "server_error",
      message: "Unexpected error (503)",
    });
  });
});

describe("authLoginPassword", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
  });

  it("posts credentials including rememberDevice to the login endpoint", async () => {
    const params = {
      displayName: "Owner",
      password: "pw",
      rememberDevice: true,
    };
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ identity, session: sessionInfo, csrfToken: "csrf-2" }),
    );

    const result = await authLoginPassword(params);

    expect(fetchWithCsrfMock).toHaveBeenCalledWith("/api/auth/login/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    expect(result).toEqual({
      ok: true,
      identity,
      session: sessionInfo,
      csrfToken: "csrf-2",
    });
  });

  it("reports rate_limited on 429", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 429));

    const result = await authLoginPassword({
      displayName: "O",
      password: "pw",
    });

    expect(result).toEqual({
      ok: false,
      status: 429,
      reason: "rate_limited",
      message: "Too many attempts — wait a moment and try again.",
    });
  });

  it("maps 401 onto invalid_credentials", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await authLoginPassword({
      displayName: "O",
      password: "wrong",
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "invalid_credentials",
      message: "Invalid display name or password.",
    });
  });

  it("maps 400 onto invalid_credentials, reporting the coerced failure status 500 as observed", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({}, 400));

    const result = await authLoginPassword({
      displayName: "",
      password: "pw",
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "invalid_credentials",
      message: "Invalid display name or password.",
    });
  });

  it("maps other non-ok statuses onto server_error", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 503));

    const result = await authLoginPassword({
      displayName: "O",
      password: "pw",
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "server_error",
      message: "Unexpected error (503)",
    });
  });

  it("keeps a non-Error transport failure as the generic network message", async () => {
    fetchWithCsrfMock.mockRejectedValueOnce(42);

    const result = await authLoginPassword({
      displayName: "O",
      password: "pw",
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "server_error",
      message: "Network error",
    });
  });
});

describe("authLogout", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
  });

  it("posts to /api/auth/logout and resolves ok on success", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 200));

    await expect(authLogout()).resolves.toEqual({ ok: true });
    expect(fetchWithCsrfMock).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
    });
  });

  it("still resolves ok when the transport fails — logout is best-effort", async () => {
    fetchWithCsrfMock.mockRejectedValueOnce(new Error("offline"));

    await expect(authLogout()).resolves.toEqual({ ok: true });
  });
});

describe("authMe over plain HTTP boundaries", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
    isManagedCloudSharedAgentBaseMock.mockReturnValue(false);
    isDesktopExternalApiBaseUrlMock.mockReturnValue(false);
    invokeDesktopBridgeRequestMock.mockReset();
    invokeDesktopBridgeRequestMock.mockResolvedValue(null);
  });

  it("returns the desktop bridge snapshot with its access info when complete", async () => {
    const access = {
      mode: "bearer" as const,
      passwordConfigured: false,
      ownerConfigured: true,
    };
    invokeDesktopBridgeRequestMock.mockResolvedValueOnce({
      identity,
      session: sessionInfo,
      access,
    });

    const result = await authMe();

    expect(result).toEqual({
      ok: true,
      identity,
      session: sessionInfo,
      access,
    });
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("fills the default local-session access when the snapshot omits it", async () => {
    invokeDesktopBridgeRequestMock.mockResolvedValueOnce({
      identity,
      session: sessionInfo,
    });

    const result = await authMe();

    expect(result).toEqual({
      ok: true,
      identity,
      session: sessionInfo,
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
  });

  it("maps an unauthorized bridge snapshot reason onto 401 remote_password_not_configured", async () => {
    const access = {
      mode: "remote" as const,
      passwordConfigured: false,
      ownerConfigured: true,
    };
    invokeDesktopBridgeRequestMock.mockResolvedValueOnce({
      unauthorized: { reason: "remote_password_not_configured", access },
    });

    const result = await authMe();

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "remote_password_not_configured",
      access,
    });
  });

  it("collapses unrecognized bridge unauthorized reasons onto server_error", async () => {
    invokeDesktopBridgeRequestMock.mockResolvedValueOnce({
      unauthorized: { reason: "warp_drive_offline", access: undefined },
    });

    const result = await authMe();

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "server_error",
      access: undefined,
    });
  });

  it("falls back to HTTP when the bridge snapshot is structurally empty", async () => {
    invokeDesktopBridgeRequestMock.mockResolvedValueOnce({});
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({
        identity,
        session: sessionInfo,
        access: {
          mode: "local",
          passwordConfigured: true,
          ownerConfigured: false,
        },
      }),
    );

    const result = await authMe();

    expect(result).toEqual({
      ok: true,
      identity,
      session: sessionInfo,
      access: {
        mode: "local",
        passwordConfigured: true,
        ownerConfigured: false,
      },
    });
  });

  it("falls back to HTTP when the bridge call throws and fills default access when the body omits it", async () => {
    invokeDesktopBridgeRequestMock.mockRejectedValueOnce(
      new Error("AgentNotReadyError"),
    );
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ identity, session: sessionInfo }),
    );

    const result = await authMe();

    expect(result).toEqual({
      ok: true,
      identity,
      session: sessionInfo,
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
  });

  it("skips the bridge entirely for an external desktop API base URL", async () => {
    isDesktopExternalApiBaseUrlMock.mockReturnValue(true);
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ identity, session: sessionInfo }),
    );

    const result = await authMe();

    expect(invokeDesktopBridgeRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      identity,
      session: sessionInfo,
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
  });

  it("propagates a 401 HTTP reason and access payload", async () => {
    const access = {
      mode: "remote" as const,
      passwordConfigured: false,
      ownerConfigured: true,
    };
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ reason: "remote_auth_required", access }, 401),
    );

    const result = await authMe();

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "remote_auth_required",
      access,
    });
  });

  it("degrades a 401 with an unparseable body to server_error without access", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 401));

    const result = await authMe();

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "server_error",
      access: undefined,
    });
  });

  it("maps any non-401 HTTP failure onto 503", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 403));

    await expect(authMe()).resolves.toEqual({ ok: false, status: 503 });
  });

  it("fails closed with 503 when the HTTP probe itself cannot connect", async () => {
    fetchWithCsrfMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(authMe()).resolves.toEqual({ ok: false, status: 503 });
  });
});

describe("authMe against a managed shared-agent base", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
    isManagedCloudSharedAgentBaseMock.mockReturnValue(true);
    isDesktopExternalApiBaseUrlMock.mockReturnValue(false);
    readStoredStewardTokenMock.mockReturnValue(null);
    writeStoredStewardTokenMock.mockResolvedValue(undefined);
    clearStoredStewardTokenMock.mockResolvedValue(undefined);
    hasStewardAuthedCookieMock.mockReturnValue(false);
    clearSharedCloudAccountBindingMock.mockClear();
    isElectrobunRuntimeMock.mockReturnValue(false);
    getElizaApiTokenMock.mockReturnValue(undefined);
    cloudTokenSecsRemainingMock.mockReset();
    refreshCloudStewardSessionMock.mockReset();
    refreshCloudStewardSessionMock.mockResolvedValue(null);
  });

  it("returns the synthetic cloud identity for a stored token with positive time remaining", async () => {
    readStoredStewardTokenMock.mockReturnValue("  stew-token  ");
    cloudTokenSecsRemainingMock.mockReturnValue(900);

    const result = await authMe();

    expect(cloudTokenSecsRemainingMock).toHaveBeenCalledWith("stew-token");
    expect(result).toEqual({
      ok: true,
      identity: { id: "cloud", displayName: "Eliza Cloud", kind: "machine" },
      session: { id: "cloud", kind: "machine", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
    expect(refreshCloudStewardSessionMock).not.toHaveBeenCalled();
  });

  it("treats an unknown expiry as still-valid without refreshing", async () => {
    readStoredStewardTokenMock.mockReturnValue("stew-token");
    cloudTokenSecsRemainingMock.mockReturnValue(null);

    const result = await authMe();

    expect(result).toEqual({
      ok: true,
      identity: { id: "cloud", displayName: "Eliza Cloud", kind: "machine" },
      session: { id: "cloud", kind: "machine", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
    expect(refreshCloudStewardSessionMock).not.toHaveBeenCalled();
  });

  it("requires re-auth with a remote access hint when no token and no authed cookie exist", async () => {
    const result = await authMe();

    expect(clearSharedCloudAccountBindingMock).toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "remote_auth_required",
      access: {
        mode: "remote",
        passwordConfigured: false,
        ownerConfigured: true,
      },
    });
    expect(refreshCloudStewardSessionMock).not.toHaveBeenCalled();
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("refreshes from the authed cookie, persists the trimmed token, and authenticates", async () => {
    hasStewardAuthedCookieMock.mockReturnValue(true);
    refreshCloudStewardSessionMock.mockResolvedValueOnce({
      token: "  fresh-stew  ",
    });
    cloudTokenSecsRemainingMock.mockReturnValue(300);

    const result = await authMe();

    expect(refreshCloudStewardSessionMock).toHaveBeenCalledWith({
      throwOnTransientHttpFailure: true,
    });
    expect(writeStoredStewardTokenMock).toHaveBeenCalledWith("fresh-stew");
    expect(cloudTokenSecsRemainingMock).toHaveBeenCalledWith("fresh-stew");
    expect(result).toEqual({
      ok: true,
      identity: { id: "cloud", displayName: "Eliza Cloud", kind: "machine" },
      session: { id: "cloud", kind: "machine", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
  });

  it("surfaces cloud_unavailable instead of logging out when a cookie-driven refresh fails transiently", async () => {
    hasStewardAuthedCookieMock.mockReturnValue(true);
    refreshCloudStewardSessionMock.mockRejectedValueOnce(
      new Error("throttled"),
    );

    const result = await authMe();

    expect(result).toEqual({
      ok: false,
      status: 503,
      reason: "cloud_unavailable",
    });
    expect(writeStoredStewardTokenMock).not.toHaveBeenCalled();
    expect(clearStoredStewardTokenMock).not.toHaveBeenCalled();
  });

  it("accepts a successful refresh for an expired token and continues authenticated", async () => {
    readStoredStewardTokenMock.mockReturnValue("stale-token");
    cloudTokenSecsRemainingMock.mockReturnValue(0);
    refreshCloudStewardSessionMock.mockResolvedValueOnce({
      token: "renewed-stew",
    });

    const result = await authMe();

    expect(refreshCloudStewardSessionMock).toHaveBeenCalledWith();
    expect(writeStoredStewardTokenMock).toHaveBeenCalledWith("renewed-stew");
    expect(result).toEqual({
      ok: true,
      identity: { id: "cloud", displayName: "Eliza Cloud", kind: "machine" },
      session: { id: "cloud", kind: "machine", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
  });

  it("clears stored state and reports remote_auth_required when an expired token cannot be refreshed", async () => {
    readStoredStewardTokenMock.mockReturnValue("stale-token");
    cloudTokenSecsRemainingMock.mockReturnValue(-5);
    refreshCloudStewardSessionMock.mockRejectedValueOnce(
      new Error("refresh rejected"),
    );

    const result = await authMe();

    expect(clearStoredStewardTokenMock).toHaveBeenCalledTimes(1);
    expect(clearSharedCloudAccountBindingMock).toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "remote_auth_required",
      access: {
        mode: "remote",
        passwordConfigured: false,
        ownerConfigured: true,
      },
    });
  });

  it("authenticates on a native owner API key even without a stored token", async () => {
    isElectrobunRuntimeMock.mockReturnValue(true);
    getBootConfigMock.mockReturnValue({
      branding: {},
      apiToken: "eliza_cloud_key",
    });

    const result = await authMe();

    expect(refreshCloudStewardSessionMock).not.toHaveBeenCalled();
    expect(clearSharedCloudAccountBindingMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      identity: { id: "cloud", displayName: "Eliza Cloud", kind: "machine" },
      session: { id: "cloud", kind: "machine", expiresAt: null },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
  });

  it("does not refresh an expired token when a native owner API key is present", async () => {
    readStoredStewardTokenMock.mockReturnValue("stale-token");
    cloudTokenSecsRemainingMock.mockReturnValue(-1);
    hasStewardAuthedCookieMock.mockReturnValue(true);
    isElectrobunRuntimeMock.mockReturnValue(true);
    getBootConfigMock.mockReturnValue({
      branding: {},
      apiToken: "eliza_cloud_key",
    });

    const result = await authMe();

    expect(refreshCloudStewardSessionMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});

describe("authListSessions", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
  });

  it("passes the session list through verbatim, including an empty list", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));

    const result = await authListSessions();

    expect(fetchWithCsrfMock).toHaveBeenCalledWith("/api/auth/sessions");
    expect(result).toEqual({ ok: true, sessions: [] });
  });

  it("returns populated session entries untouched", async () => {
    const sessions = [
      {
        id: "s-1",
        kind: "browser" as const,
        ip: "10.0.0.2",
        userAgent: "Mozilla/5.0",
        lastSeenAt: 1000,
        expiresAt: 2000,
        current: true,
      },
    ];
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({ sessions }));

    const result = await authListSessions();

    expect(result).toEqual({ ok: true, sessions });
  });

  it("maps a transport failure onto 401", async () => {
    fetchWithCsrfMock.mockRejectedValueOnce(new Error("offline"));

    await expect(authListSessions()).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });

  it("preserves 503 from the endpoint", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 503));

    await expect(authListSessions()).resolves.toEqual({
      ok: false,
      status: 503,
    });
  });

  it("collapses other non-ok statuses onto 401", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 500));

    await expect(authListSessions()).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });
});

describe("authRevokeSession", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
  });

  it("percent-encodes the session id in the revoke URL", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 200));

    const result = await authRevokeSession("s1/ab?c=d");

    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      `/api/auth/sessions/${encodeURIComponent("s1/ab?c=d")}/revoke`,
      { method: "POST" },
    );
    expect(result).toEqual({ ok: true });
  });

  it("preserves 404 for an unknown session", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 404));

    await expect(authRevokeSession("gone")).resolves.toEqual({
      ok: false,
      status: 404,
    });
  });

  it("preserves 401 for an unauthenticated caller", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 401));

    await expect(authRevokeSession("s-1")).resolves.toEqual({
      ok: false,
      status: 401,
    });
  });

  it("collapses other endpoint statuses onto 500", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 503));

    await expect(authRevokeSession("s-1")).resolves.toEqual({
      ok: false,
      status: 500,
    });
  });

  it("maps a transport failure onto 500", async () => {
    fetchWithCsrfMock.mockRejectedValueOnce(new Error("offline"));

    await expect(authRevokeSession("s-1")).resolves.toEqual({
      ok: false,
      status: 500,
    });
  });
});

describe("authChangePassword", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
  });

  it("posts both passwords to /api/auth/password/change and resolves ok", async () => {
    const params = { currentPassword: "old", newPassword: "new" };
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 200));

    const result = await authChangePassword(params);

    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/auth/password/change",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it("maps a weak-password rejection onto weak_password", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ reason: "weak_password" }, 400),
    );

    const result = await authChangePassword({ newPassword: "weak" });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: "weak_password",
      message:
        "Password too weak. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    });
  });

  it("degrades a 400 with any other reason to a 500-shaped server_error", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ reason: "unknown_rule" }, 400),
    );

    const result = await authChangePassword({ newPassword: "whatever" });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "server_error",
      message: "Unexpected error (400)",
    });
  });

  it("maps 401 onto invalid_credentials", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await authChangePassword({
      currentPassword: "wrong",
      newPassword: "new",
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "invalid_credentials",
      message: "Current password is incorrect.",
    });
  });

  it("maps 404 onto owner_not_found", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({}, 404));

    const result = await authChangePassword({ newPassword: "new" });

    expect(result).toEqual({
      ok: false,
      status: 404,
      reason: "owner_not_found",
      message: "No owner account exists yet.",
    });
  });

  it("maps 429 onto rate_limited", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 429));

    const result = await authChangePassword({ newPassword: "new" });

    expect(result).toEqual({
      ok: false,
      status: 429,
      reason: "rate_limited",
      message: "Too many attempts — wait a moment and try again.",
    });
  });

  it("maps other endpoint statuses onto server_error with the status embedded", async () => {
    fetchWithCsrfMock.mockResolvedValueOnce(textResponse("", 503));

    const result = await authChangePassword({ newPassword: "new" });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "server_error",
      message: "Unexpected error (503)",
    });
  });

  it("keeps a non-Error transport failure as the generic network message", async () => {
    fetchWithCsrfMock.mockRejectedValueOnce(undefined);

    const result = await authChangePassword({ newPassword: "new" });

    expect(result).toEqual({
      ok: false,
      status: 500,
      reason: "server_error",
      message: "Network error",
    });
  });
});
