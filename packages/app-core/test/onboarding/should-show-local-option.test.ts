import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalAgentProbeCache,
  shouldShowLocalOption,
} from "../../src/onboarding/probe-local-agent";

describe("shouldShowLocalOption", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearLocalAgentProbeCache();
    fetchMock = vi.fn();
    (globalThis as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    clearLocalAgentProbeCache();
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it("returns true on desktop without probing", async () => {
    await expect(
      shouldShowLocalOption({
        isDesktop: true,
        isDev: false,
        isAndroid: false,
      }),
    ).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns true in dev mode without probing", async () => {
    await expect(
      shouldShowLocalOption({
        isDesktop: false,
        isDev: true,
        isAndroid: false,
      }),
    ).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns true on Android when the agent probe succeeds", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      shouldShowLocalOption({
        isDesktop: false,
        isDev: false,
        isAndroid: true,
      }),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false on Android when the agent probe fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      shouldShowLocalOption({
        isDesktop: false,
        isDev: false,
        isAndroid: true,
      }),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false on iOS / web without probing", async () => {
    await expect(
      shouldShowLocalOption({
        isDesktop: false,
        isDev: false,
        isAndroid: false,
      }),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The Android APK uses the local on-device agent unconditionally (the
  // picker is bypassed by `preSeedAndroidLocalRuntimeIfFresh` + RuntimeGate's
  // Android branch). On that platform `shouldShowLocalOption` is **not** a
  // gate on whether to offer the local option — it always is — but a
  // *readiness* signal that `RuntimeGate`'s Android splash polls so it
  // knows when to call `finishAsLocal()` and hand control to chat.
  describe("Android readiness signal (not a visibility gate)", () => {
    it("transitions from false → true once the on-device agent comes online", async () => {
      fetchMock
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ready: true, agentState: "running" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );

      // Before the agent is up, the readiness signal is `false`.
      await expect(
        shouldShowLocalOption({
          isDesktop: false,
          isDev: false,
          isAndroid: true,
        }),
      ).resolves.toBe(false);

      // The negative cache TTL is 3 s; clear it so a re-probe actually fires.
      clearLocalAgentProbeCache();

      // Once the agent answers `/api/health`, readiness flips to `true`.
      await expect(
        shouldShowLocalOption({
          isDesktop: false,
          isDev: false,
          isAndroid: true,
        }),
      ).resolves.toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
