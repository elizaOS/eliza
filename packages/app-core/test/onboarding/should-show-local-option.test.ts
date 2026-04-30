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
});
