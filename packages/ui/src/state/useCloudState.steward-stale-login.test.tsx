// @vitest-environment jsdom
//
// Sign-in first-click dead-end regression. With a stored-but-EXPIRED Steward
// JWT and NO mounted Steward launcher (registerStewardLoginLauncher has no
// production caller today, so the dashboard always runs launcher-less),
// handleCloudLogin used to enter the Steward branch anyway: launchStewardLogin
// drained the stale token and then threw "the Steward login surface is not
// mounted", so the FIRST click surfaced a sign-in error and only the SECOND
// click (token now gone) reached the working device-code flow. These tests
// lock the fix: the first click drains the stale token and proceeds straight
// to the device-code flow, while a still-usable token and a mounted launcher
// keep their existing Steward-branch behavior.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { registerStewardLoginLauncher } from "./cloud-steward-login";
import { useCloudState } from "./useCloudState";

const STEWARD_TOKEN_KEY = "steward_session_token";
const NOT_MOUNTED_ERROR = /Steward login surface is not mounted/;
const DEVICE_CODE_SENTINEL = "device-code-flow-reached";

/** Build a minimal (unsigned) JWT whose payload carries the given `exp`. */
function makeJwt(expSecondsFromNow: number | null): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = enc({ alg: "none", typ: "JWT" });
  const payload = enc(
    expSecondsFromNow === null
      ? {}
      : { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow },
  );
  return `${header}.${payload}.sig`;
}

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — handleCloudLogin with a stale Steward token and no launcher", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;
  let cloudLoginSpy: ReturnType<typeof vi.spyOn>;
  let cloudLoginDirectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    // The mount-time token-lifecycle refresh fires on stored-token presence;
    // fail it so the stale token stays in place for the click under test.
    fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Whichever legacy entry point the environment resolves to (agent proxy vs
    // direct cloud auth), report a controlled failure so the login flow stops
    // deterministically without starting the browser-poll interval.
    cloudLoginSpy = vi.spyOn(client, "cloudLogin").mockResolvedValue({
      ok: false,
      sessionId: "",
      browserUrl: "",
      error: DEVICE_CODE_SENTINEL,
    });
    cloudLoginDirectSpy = vi
      .spyOn(client, "cloudLoginDirect")
      .mockResolvedValue({
        ok: false,
        sessionId: "",
        browserUrl: "",
        error: DEVICE_CODE_SENTINEL,
      });
    vi.spyOn(client, "getCloudStatus").mockResolvedValue({
      connected: false,
      enabled: false,
    } as Awaited<ReturnType<typeof client.getCloudStatus>>);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const deviceCodeCalls = () =>
    cloudLoginSpy.mock.calls.length + cloudLoginDirectSpy.mock.calls.length;

  it("first click falls through to the device-code flow instead of throwing 'not mounted'", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin();
    });

    // The FIRST click must reach the legacy device-code flow…
    expect(deviceCodeCalls()).toBe(1);
    // …surface only that flow's outcome (never the launcher-missing throw)…
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
    expect(result.current.elizaCloudLoginError).not.toMatch(NOT_MOUNTED_ERROR);
    // …and drain the stale token so it cannot shadow later authed calls.
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("a still-usable stored token keeps the Steward short-circuit (no device-code call)", async () => {
    const valid = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, valid);

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin();
    });

    expect(deviceCodeCalls()).toBe(0);
    expect(result.current.elizaCloudLoginError ?? "").not.toMatch(
      NOT_MOUNTED_ERROR,
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(valid);
  });

  it("a mounted launcher still owns the stale-token re-auth (no device-code call)", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    const launcher = vi.fn(async () => ({ token: makeJwt(3600) }));
    const unregister = registerStewardLoginLauncher(launcher);
    try {
      const { result } = renderHook(() => useCloudState(makeParams()));
      await act(async () => {
        await result.current.handleCloudLogin();
      });

      await waitFor(() => expect(launcher).toHaveBeenCalledTimes(1));
      expect(deviceCodeCalls()).toBe(0);
      expect(result.current.elizaCloudLoginError ?? "").not.toMatch(
        NOT_MOUNTED_ERROR,
      );
    } finally {
      unregister();
    }
  });
});
