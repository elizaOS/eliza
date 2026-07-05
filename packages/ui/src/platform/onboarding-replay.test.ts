/**
 * #14382 — proves the dev-gated onboarding replay is NON-DESTRUCTIVE.
 *
 * The whole point of this mechanism is that a developer can re-run onboarding
 * on a real, memory-laden agent WITHOUT the destructive `POST /api/agent/reset`
 * (which wipes the PGlite data dir — conversations/knowledge/trajectories).
 * These tests lock that guarantee: the replay must NEVER call a delete/reset,
 * NEVER clear the persisted active-server, and must restore the client verbatim
 * on uninstall. It also must be compiled out (inert) in prod builds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armOnboardingReplay,
  isOnboardingReplayRequested,
  isOnboardingReplaySupported,
  ONBOARDING_REPLAY_QUERY_PARAM,
} from "./onboarding-replay";
import type { FirstRunClientLike } from "./types";

/**
 * A spy client that records EVERY method touched. If the replay ever reaches
 * for a destructive method, these spies fire and the test fails.
 */
function makeSpyClient() {
  const originalGetConfig = vi.fn(async () => ({
    meta: { firstRunComplete: true },
    agentName: "Real Agent",
  }));
  const originalGetFirstRunStatus = vi.fn(async () => ({ complete: true }));
  const originalSubmitFirstRun = vi.fn(async () => ({ ok: true }));

  // Destructive methods that MUST NOT be invoked by a replay.
  const deleteAgent = vi.fn(async () => ({ ok: true }));
  const resetAgent = vi.fn(async () => ({ ok: true }));
  const clearMemories = vi.fn(async () => ({ ok: true }));

  const client = {
    getConfig: originalGetConfig,
    getFirstRunStatus: originalGetFirstRunStatus,
    submitFirstRun: originalSubmitFirstRun,
    // Present so we can assert they are never called.
    deleteAgent,
    resetAgent,
    clearMemories,
  } as unknown as FirstRunClientLike & {
    deleteAgent: typeof deleteAgent;
    resetAgent: typeof resetAgent;
    clearMemories: typeof clearMemories;
  };

  return {
    client,
    originalGetConfig,
    originalGetFirstRunStatus,
    originalSubmitFirstRun,
    deleteAgent,
    resetAgent,
    clearMemories,
  };
}

function urlWithReplay(): URL {
  return new URL(`https://dev.local/?${ONBOARDING_REPLAY_QUERY_PARAM}=1`);
}

describe("onboarding-replay (dev-gated, non-destructive)", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is inert in a prod build (no replay even with the query param)", () => {
    vi.stubEnv("DEV", false);
    expect(isOnboardingReplaySupported()).toBe(false);
    expect(isOnboardingReplayRequested(urlWithReplay())).toBe(false);

    const { client } = makeSpyClient();
    const handle = armOnboardingReplay(client, { url: urlWithReplay() });
    expect(handle.active).toBe(false);
  });

  it("does not arm without the query param", () => {
    const { client } = makeSpyClient();
    const handle = armOnboardingReplay(client, {
      url: new URL("https://dev.local/"),
    });
    expect(handle.active).toBe(false);
  });

  it("arms in dev with ?onboarding-replay=1 and reports fresh WITHOUT any destructive call", async () => {
    const spies = makeSpyClient();
    const handle = armOnboardingReplay(spies.client, { url: urlWithReplay() });

    expect(handle.active).toBe(true);

    // Overlay makes the client REPORT fresh...
    const status = await spies.client.getFirstRunStatus();
    expect(status.complete).toBe(false);
    const config = await spies.client.getConfig();
    expect(config).toEqual({});

    // ...but NEVER calls anything destructive.
    expect(spies.deleteAgent).not.toHaveBeenCalled();
    expect(spies.resetAgent).not.toHaveBeenCalled();
    expect(spies.clearMemories).not.toHaveBeenCalled();

    handle.uninstall();
  });

  it("never clears the persisted active-server (unlike ?reset)", () => {
    const removed: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: (k: string) => {
        removed.push(k);
      },
    };

    const { client } = makeSpyClient();
    const handle = armOnboardingReplay(client, {
      url: urlWithReplay(),
      storage,
    });
    expect(handle.active).toBe(true);

    // The active-server key must NEVER be removed by the replay path.
    expect(removed).not.toContain("elizaos:active-server");
    handle.uninstall();
  });

  it("never touches the durable force-fresh restore key (uses ephemeral storage)", async () => {
    const touchedKeys: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (k: string) => {
        touchedKeys.push(k);
      },
      removeItem: (k: string) => {
        touchedKeys.push(k);
      },
    };

    const { client } = makeSpyClient();
    // Drive the overlay methods so any storage write would surface.
    const handle = armOnboardingReplay(client, {
      url: urlWithReplay(),
      storage,
    });
    await client.getFirstRunStatus();
    await client.getConfig();
    handle.uninstall();

    // The durable restore key must never be written via the passed-in storage.
    expect(touchedKeys).not.toContain("elizaos:first-run:force-fresh");
  });

  it("restores the client verbatim on uninstall (real agent unchanged after replay)", async () => {
    const spies = makeSpyClient();

    const handle = armOnboardingReplay(spies.client, { url: urlWithReplay() });
    expect(handle.active).toBe(true);

    // During replay: reports fresh.
    expect((await spies.client.getFirstRunStatus()).complete).toBe(false);

    handle.uninstall();

    // After uninstall: the REAL methods answer again — agent is exactly as it
    // was, still complete, real config intact, no data destroyed.
    const status = await spies.client.getFirstRunStatus();
    expect(status.complete).toBe(true);
    const config = await spies.client.getConfig();
    expect(config).toMatchObject({ agentName: "Real Agent" });

    // Still no destructive call across the whole lifecycle.
    expect(spies.deleteAgent).not.toHaveBeenCalled();
    expect(spies.resetAgent).not.toHaveBeenCalled();
    expect(spies.clearMemories).not.toHaveBeenCalled();
  });

  it("submitting the replay onboarding lifts the overlay without deleting anything", async () => {
    const spies = makeSpyClient();
    const handle = armOnboardingReplay(spies.client, { url: urlWithReplay() });

    // Simulate the user finishing the replayed onboarding.
    await spies.client.submitFirstRun({} as never);
    // The real submit ran exactly once (the overlay wraps, not replaces).
    expect(spies.originalSubmitFirstRun).toHaveBeenCalledTimes(1);
    // And still nothing destructive.
    expect(spies.deleteAgent).not.toHaveBeenCalled();
    expect(spies.resetAgent).not.toHaveBeenCalled();

    handle.uninstall();
  });
});
