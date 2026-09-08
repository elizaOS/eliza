/** Verifies useCloudState — Steward refresh arms on stored-token presence through the package's configured test harness. */
// @vitest-environment jsdom
//
// #10231 launch-blocker #4 — the Cloud=Steward token-lifecycle refresh must arm
// on stored-token PRESENCE, not on `elizaCloudConnected`. A returning user's
// stored JWT can already be expired at mount; `elizaCloudConnected` only flips
// true after a successful status/credits poll, which can't happen while every
// call 401s on the dead token. Gating on the connection flag therefore
// deadlocked expired-token users. These tests lock the presence-gated behavior.

import { registerStewardTokenPersistence } from "@elizaos/shared/steward-session-client";
import { act, renderHook, waitFor } from "@testing-library/react";
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

  it.each(["pagehide", "unmount"])(
    "cancels the pending refresh request on %s",
    async (departure) => {
      const stale = makeJwt(-60);
      localStorage.setItem(STEWARD_TOKEN_KEY, stale);
      let release!: () => void;
      let signal: AbortSignal | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      fetchMock.mockImplementation(async (_url, options: RequestInit) => {
        signal = options.signal ?? undefined;
        await held;
        return { ok: true, json: async () => ({ token: makeJwt(3600) }) };
      });
      const mounted = renderHook(() => useCloudState(makeParams()));
      try {
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        if (departure === "unmount") mounted.unmount();
        else act(() => window.dispatchEvent(new Event("pagehide")));
        expect(signal?.aborted).toBe(true);
      } finally {
        release();
        await act(flush);
        mounted.unmount();
      }
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(stale);
    },
  );

  it.each(["pagehide", "unmount"])(
    "does not publish a refreshed token after %s during persistence",
    async (departure) => {
      const stale = makeJwt(-60);
      localStorage.setItem(STEWARD_TOKEN_KEY, stale);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const publish = vi.fn();
      const unregister = registerStewardTokenPersistence(
        async (token, validate, scope) => {
          entered = true;
          await held;
          validate();
          scope.commit(() => {
            localStorage.setItem(STEWARD_TOKEN_KEY, token);
            publish();
          });
        },
      );
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ token: makeJwt(3600) }),
      });
      const mounted = renderHook(() => useCloudState(makeParams()));
      try {
        await waitFor(() => expect(entered).toBe(true));
        if (departure === "unmount") mounted.unmount();
        else act(() => window.dispatchEvent(new Event("pagehide")));
        release();
        await act(flush);
        expect(publish).not.toHaveBeenCalled();
        expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(stale);
      } finally {
        release();
        await act(flush);
        mounted.unmount();
        unregister();
      }
    },
  );

  it("starts a fresh attempt on pageshow without reviving the departed request", async () => {
    const stale = makeJwt(-60);
    const obsolete = makeJwt(1800);
    const fresh = makeJwt(3600);
    localStorage.setItem(STEWARD_TOKEN_KEY, stale);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      await held;
      return { ok: true, json: async () => ({ token: obsolete }) };
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });
    const mounted = renderHook(() => useCloudState(makeParams()));
    try {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("pageshow"));
      });
      await act(flush);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(stale);
      release();
      await waitFor(() =>
        expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(fresh),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await act(flush);
      mounted.unmount();
    }
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
