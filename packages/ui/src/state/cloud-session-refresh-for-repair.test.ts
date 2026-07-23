/**
 * @vitest-environment jsdom
 *
 * Tests for ensureCloudSessionForRepair: the silent cookie->session recovery
 * that unblocks the returning-PWA re-pair path (closes the
 * "Open this agent from Eliza Cloud" dead-end).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the heavy client-cloud + shared-session imports: every test injects its
// own refreshFn/readToken/writeToken/hasCookie, so the module-default imports
// are never exercised. Mocking them keeps this a fast, isolated unit test and
// avoids pulling the client-cloud transitive dependency chain.
vi.mock("../api/client-cloud", () => ({
  refreshCloudStewardSession: async () => null,
}));
vi.mock("@elizaos/shared/steward-session-client", () => ({
  hasStewardAuthedCookie: () => false,
  readStoredStewardToken: () => null,
  writeStoredStewardToken: () => {},
}));

import { ensureCloudSessionForRepair } from "./cloud-session-refresh-for-repair";

function makeDeps(
  over: Partial<Parameters<typeof ensureCloudSessionForRepair>[0]> = {},
) {
  return {
    hasCookie: vi.fn(() => true),
    readToken: vi.fn<() => string | null>(() => null),
    refreshFn: vi.fn(async () => ({ token: "fresh.jwt" })),
    writeToken: vi.fn<(t: string) => void>(),
    // Immediate race resolution so tests never wait on real timers.
    raceTimeout: (<T>(p: Promise<T>) => p) as <T>(
      p: Promise<T>,
      ms: number,
    ) => Promise<T | null>,
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

describe("ensureCloudSessionForRepair", () => {
  it("fast-path: returns the existing app-origin token without refreshing", async () => {
    const deps = makeDeps({ readToken: vi.fn(() => "existing.jwt") });
    const token = await ensureCloudSessionForRepair(deps);
    expect(token).toBe("existing.jwt");
    expect(deps.refreshFn).not.toHaveBeenCalled();
    expect(deps.writeToken).not.toHaveBeenCalled();
  });

  it("recovers the session from the shared cookie and persists it", async () => {
    const deps = makeDeps();
    const token = await ensureCloudSessionForRepair(deps);
    expect(token).toBe("fresh.jwt");
    expect(deps.refreshFn).toHaveBeenCalledTimes(1);
    expect(deps.writeToken).toHaveBeenCalledWith("fresh.jwt");
  });

  it("returns null (keeps the wall) when there is no shared cookie", async () => {
    const deps = makeDeps({ hasCookie: vi.fn(() => false) });
    const token = await ensureCloudSessionForRepair(deps);
    expect(token).toBeNull();
    expect(deps.refreshFn).not.toHaveBeenCalled();
    expect(deps.writeToken).not.toHaveBeenCalled();
  });

  it("returns null when the cookie refresh yields no token (fails closed)", async () => {
    const deps = makeDeps({ refreshFn: vi.fn(async () => null) });
    const token = await ensureCloudSessionForRepair(deps);
    expect(token).toBeNull();
    expect(deps.writeToken).not.toHaveBeenCalled();
  });

  it("returns null when the refresh throws (never fabricates a session)", async () => {
    const deps = makeDeps({
      refreshFn: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    const token = await ensureCloudSessionForRepair(deps);
    expect(token).toBeNull();
    expect(deps.writeToken).not.toHaveBeenCalled();
  });

  it("returns null when the refresh times out (bounded, never hangs the gate)", async () => {
    const deps = makeDeps({
      refreshFn: vi.fn(() => new Promise(() => {})), // never resolves
      raceTimeout: (() => Promise.resolve(null)) as <T>(
        p: Promise<T>,
        ms: number,
      ) => Promise<T | null>,
    });
    const token = await ensureCloudSessionForRepair(deps);
    expect(token).toBeNull();
    expect(deps.writeToken).not.toHaveBeenCalled();
  });

  it("trims whitespace on both the existing token and the recovered token", async () => {
    const existing = makeDeps({ readToken: vi.fn(() => "  padded.jwt  ") });
    expect(await ensureCloudSessionForRepair(existing)).toBe("padded.jwt");

    const recovered = makeDeps({
      refreshFn: vi.fn(async () => ({ token: "  fresh.jwt  " })),
    });
    expect(await ensureCloudSessionForRepair(recovered)).toBe("fresh.jwt");
    expect(recovered.writeToken).toHaveBeenCalledWith("fresh.jwt");
  });
});
