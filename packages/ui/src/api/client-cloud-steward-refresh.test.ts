// @vitest-environment jsdom
//
// #11941 — native/desktop Steward JWT refresh. On web the session refresh rides
// the same-origin HttpOnly `steward-refresh-token` cookie (`credentials:
// "include"`, no Authorization header). Native (Capacitor) / desktop have no
// such cookie, so the refresh must instead authenticate with the stored Steward
// JWT via `Authorization: Bearer`. These tests lock both paths: the web cookie
// POST stays byte-identical, and native sends the Bearer header over the native
// HTTP bridge and persists/returns the rotated token (invalid tokens → null).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capacitorState, capacitorHttpRequestMock } = vi.hoisted(() => ({
  capacitorState: { isNative: false },
  capacitorHttpRequestMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
  },
  CapacitorHttp: {
    request: capacitorHttpRequestMock,
  },
}));

import { refreshCloudStewardSession } from "./client-cloud";

const STEWARD_TOKEN_KEY = "steward_session_token";
const NATIVE_ENDPOINT = "https://api.elizacloud.ai/api/auth/steward-refresh";
const SAME_ORIGIN_ENDPOINT = "/api/auth/steward-refresh";

describe("refreshCloudStewardSession — native/desktop Bearer refresh (#11941)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    capacitorState.isNative = false;
    capacitorHttpRequestMock.mockReset();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("native: POSTs the stored Steward JWT as Authorization: Bearer over the native HTTP bridge and returns the rotated token", async () => {
    capacitorState.isNative = true;
    localStorage.setItem(STEWARD_TOKEN_KEY, "stored-jwt");
    capacitorHttpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: { token: "rotated-jwt", expiresIn: 3600 },
    });

    const result = await refreshCloudStewardSession({
      endpoint: NATIVE_ENDPOINT,
    });

    // No same-origin cookie fetch on native.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(capacitorHttpRequestMock).toHaveBeenCalledTimes(1);
    const req = capacitorHttpRequestMock.mock.calls[0][0];
    expect(req).toMatchObject({ url: NATIVE_ENDPOINT, method: "POST" });
    expect(req.headers.Authorization).toBe("Bearer stored-jwt");
    expect(result).toEqual({ token: "rotated-jwt", expiresIn: 3600 });
  });

  it("native: parses a stringified JSON body from the native bridge", async () => {
    capacitorState.isNative = true;
    localStorage.setItem(STEWARD_TOKEN_KEY, "stored-jwt");
    capacitorHttpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: JSON.stringify({ token: "rotated-jwt" }),
    });

    const result = await refreshCloudStewardSession({
      endpoint: NATIVE_ENDPOINT,
    });

    expect(result).toEqual({ token: "rotated-jwt" });
  });

  it("native: returns null (no request) when no Steward token is stored", async () => {
    capacitorState.isNative = true;

    const result = await refreshCloudStewardSession({
      endpoint: NATIVE_ENDPOINT,
    });

    expect(result).toBeNull();
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("native: returns null when the server rejects the Bearer token (401 invalid/expired)", async () => {
    capacitorState.isNative = true;
    localStorage.setItem(STEWARD_TOKEN_KEY, "expired-jwt");
    capacitorHttpRequestMock.mockResolvedValue({
      status: 401,
      headers: {},
      data: { error: "Refresh token rejected", code: "invalid_token" },
    });

    const result = await refreshCloudStewardSession({
      endpoint: NATIVE_ENDPOINT,
    });

    expect(result).toBeNull();
  });

  it("web: keeps the same-origin cookie POST byte-identical (credentials include, NO Authorization header)", async () => {
    // A stored token exists on web too, but the web path must NOT send it as a
    // Bearer header — it rides the HttpOnly cookie instead.
    localStorage.setItem(STEWARD_TOKEN_KEY, "web-jwt");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "rotated-web-jwt" }),
    });

    const result = await refreshCloudStewardSession();

    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SAME_ORIGIN_ENDPOINT);
    expect(init).toEqual({ method: "POST", credentials: "include" });
    expect(init.headers).toBeUndefined();
    expect(result).toEqual({ token: "rotated-web-jwt" });
  });

  it("web: returns null on a non-2xx cookie refresh", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const result = await refreshCloudStewardSession();

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
