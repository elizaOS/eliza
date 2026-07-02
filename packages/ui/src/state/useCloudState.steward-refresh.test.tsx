// @vitest-environment jsdom
//
// #10231 launch-blocker #4 — the Cloud=Steward token-lifecycle refresh must arm
// on stored-token PRESENCE, not on `elizaCloudConnected`. A returning user's
// stored JWT can already be expired at mount; `elizaCloudConnected` only flips
// true after a successful status/credits poll, which can't happen while every
// call 401s on the dead token. Gating on the connection flag therefore
// deadlocked expired-token users. These tests lock the presence-gated behavior.

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloudState } from "./useCloudState";

const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_REFRESH_PATH = "/api/auth/steward-refresh";

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

/** Yield a few macrotasks so mount effects (and their async bodies) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("useCloudState — Steward refresh arms on stored-token presence", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("refreshes an expired stored JWT at mount even while disconnected (deadlock fix)", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, makeJwt(-60));
    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    const { result } = renderHook(() => useCloudState(makeParams()));
    // Never connected — the effect must still fire on stored-token presence.
    expect(result.current.elizaCloudConnected).toBe(false);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(STEWARD_REFRESH_PATH);
    // On success the refreshed token is mirrored back to localStorage.
    await waitFor(() =>
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(fresh),
    );
  });

  it("does NOT refresh a comfortably-valid stored JWT (no needless work)", async () => {
    const valid = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, valid);

    renderHook(() => useCloudState(makeParams()));
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(valid);
  });

  it("does nothing when no Steward token is stored", async () => {
    renderHook(() => useCloudState(makeParams()));
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the session unauthenticated without looping when refresh fails", async () => {
    const stale = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, stale);
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const { result } = renderHook(() => useCloudState(makeParams()));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The 60s lifecycle interval has not advanced — exactly one mount attempt,
    // no tight retry loop.
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.elizaCloudConnected).toBe(false);
    // The stale token is left in place for pollCloudCredits() to surface as
    // auth-rejected (the effect never wipes it on a failed refresh).
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(stale);
  });
});
