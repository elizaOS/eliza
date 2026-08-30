/** Verifies runHydrating — non-blocking first-load (F2) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Regression: runHydrating() must reach HYDRATION_COMPLETE without blocking on
 * slow/hanging shell-decoration work (first-5 strike F2, ported from
 * milady-ai/milady#2209).
 *
 * On cloud containers getWalletAddresses() was measured at 1.3–12.4 s
 * (staging median 7.8 s, probe evidence in
 * projects/eliza-fleet/F5-FIRSTLOAD-2026-07-22.md). eliza's runHydrating
 * already runs wallet/avatar/autonomy-replay AFTER dispatching
 * HYDRATION_COMPLETE (decorateShellAfterReady, #15178) — this test pins that
 * invariant so a future refactor cannot quietly re-await any of them on the
 * ready critical path. Every decoration dependency hangs FOREVER here; the
 * dashboard must still become interactive.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupEvent } from "./startup-coordinator";

const hangForever = () => new Promise<never>(() => {});

const clientMock = vi.hoisted(() => {
  const hang = () => new Promise<never>(() => {});
  return {
    connectWs: vi.fn(),
    getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
    // The hangers — must NOT block hydration:
    getWalletAddresses: vi.fn(() => hang()),
    getConfig: vi.fn(() => hang()),
    getStreamSettings: vi.fn(() => hang()),
  };
});

vi.mock("../api", () => ({ client: clientMock }));
vi.mock("../components/apps/load-apps-catalog", () => ({
  prefetchAppsCatalog: vi.fn(async () => undefined),
}));

import { type HydratingDeps, runHydrating } from "./startup-phase-hydrate";

function makeDeps(): HydratingDeps {
  return {
    setStartupError: vi.fn(),
    setFirstRunLoading: vi.fn(),
    hydrateInitialConversationState: vi.fn(async () => null),
    activeConversationIdRef: { current: null },
    loadedConversationIdRef: { current: null },
    loadConversationMessages: vi.fn(async (_conversationId: string) => ({
      ok: true as const,
    })),
    requestGreetingWhenRunningRef: { current: vi.fn(async () => undefined) },
    loadWorkbench: vi.fn(async () => {}),
    loadPlugins: vi.fn(async () => {}),
    loadSkills: vi.fn(async () => {}),
    loadCharacter: vi.fn(async () => {}),
    loadWalletConfig: vi.fn(async () => {}),
    loadInventory: vi.fn(async () => {}),
    loadUpdateStatus: vi.fn(async () => {}),
    checkExtensionStatus: vi.fn(async () => {}),
    pollCloudCredits: vi.fn(),
    // Autonomy replay hangs forever — must NOT block hydration.
    fetchAutonomyReplay: vi.fn(() => hangForever()),
    setSelectedVrmIndex: vi.fn(),
    setWalletAddresses: vi.fn(),
    setTab: vi.fn(),
    setTabRaw: vi.fn(),
    initialTabSetRef: { current: false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("runHydrating — non-blocking first-load (F2)", () => {
  it("does not await conversation history on a limited Cloud agent base", async () => {
    clientMock.getBaseUrl.mockReturnValueOnce(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/bridge",
    );
    const deps = makeDeps();
    deps.hydrateInitialConversationState = vi.fn(() => hangForever());
    const events: StartupEvent[] = [];

    await Promise.race([
      runHydrating(deps, (event) => events.push(event), { current: false }),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Cloud conversation hydration blocked paint")),
          1_000,
        ),
      ),
    ]);

    expect(deps.hydrateInitialConversationState).toHaveBeenCalledTimes(1);
    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
    expect(events).toContainEqual({ type: "HYDRATION_COMPLETE" });
  });

  it("refetches the retained direct-Cloud conversation when initial message hydration was incomplete", async () => {
    clientMock.getBaseUrl.mockReturnValueOnce(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/bridge",
    );
    const deps = makeDeps();
    deps.hydrateInitialConversationState = vi.fn(async () => {
      deps.activeConversationIdRef.current = "conversation-1";
      return null;
    });
    deps.loadConversationMessages = vi.fn(async (conversationId) => {
      deps.loadedConversationIdRef.current = conversationId;
      return { ok: true as const };
    });

    await runHydrating(deps, vi.fn(), { current: false });

    await vi.waitFor(() => {
      expect(deps.loadConversationMessages).toHaveBeenCalledTimes(1);
    });
    expect(deps.loadConversationMessages).toHaveBeenCalledWith(
      "conversation-1",
    );
  });

  it("retries the whole direct-Cloud hydrate once when a persisted conversation list cannot load", async () => {
    vi.useFakeTimers();
    clientMock.getBaseUrl.mockReturnValueOnce(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/bridge",
    );
    window.localStorage.setItem(
      "eliza:chat:activeConversationId",
      "conversation-1",
    );
    const deps = makeDeps();
    deps.hydrateInitialConversationState = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("conversation list unavailable"))
      .mockImplementationOnce(async () => {
        deps.activeConversationIdRef.current = "conversation-1";
        deps.loadedConversationIdRef.current = "conversation-1";
        return null;
      });

    await runHydrating(deps, vi.fn(), { current: false });
    await Promise.resolve();
    expect(deps.hydrateInitialConversationState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(deps.hydrateInitialConversationState).toHaveBeenCalledTimes(2);
    expect(deps.loadConversationMessages).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not duplicate a successful direct-Cloud history load", async () => {
    clientMock.getBaseUrl.mockReturnValueOnce(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/bridge",
    );
    const deps = makeDeps();
    deps.hydrateInitialConversationState = vi.fn(async () => {
      deps.activeConversationIdRef.current = "conversation-1";
      deps.loadedConversationIdRef.current = "conversation-1";
      return null;
    });

    await runHydrating(deps, vi.fn(), { current: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.loadConversationMessages).not.toHaveBeenCalled();
  });

  it("retries one incomplete direct-Cloud message load once", async () => {
    vi.useFakeTimers();
    clientMock.getBaseUrl.mockReturnValueOnce(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/bridge",
    );
    const deps = makeDeps();
    deps.hydrateInitialConversationState = vi.fn(async () => {
      deps.activeConversationIdRef.current = "conversation-1";
      return null;
    });
    deps.loadConversationMessages = vi
      .fn<
        (
          conversationId: string,
        ) => Promise<{ ok: true } | { ok: false; message: string }>
      >()
      .mockResolvedValueOnce({ ok: false, message: "offline" })
      .mockImplementationOnce(async (conversationId) => {
        deps.loadedConversationIdRef.current = conversationId;
        return { ok: true };
      });

    await runHydrating(deps, vi.fn(), { current: false });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.loadConversationMessages).toHaveBeenNthCalledWith(
      1,
      "conversation-1",
    );
    expect(deps.loadConversationMessages).toHaveBeenNthCalledWith(
      2,
      "conversation-1",
    );
    vi.useRealTimers();
  });

  it("does not repaint a stale conversation after the active target changes", async () => {
    vi.useFakeTimers();
    clientMock.getBaseUrl.mockReturnValueOnce(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/bridge",
    );
    const deps = makeDeps();
    deps.hydrateInitialConversationState = vi.fn(async () => {
      deps.activeConversationIdRef.current = "conversation-1";
      return null;
    });
    deps.loadConversationMessages = vi
      .fn<
        (
          conversationId: string,
        ) => Promise<{ ok: true } | { ok: false; message: string }>
      >()
      .mockImplementationOnce(async () => {
        deps.activeConversationIdRef.current = "conversation-2";
        return { ok: false, message: "offline" };
      })
      .mockImplementationOnce(async (conversationId) => {
        deps.loadedConversationIdRef.current = conversationId;
        return { ok: true };
      });

    await runHydrating(deps, vi.fn(), { current: false });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.loadConversationMessages).toHaveBeenNthCalledWith(
      1,
      "conversation-1",
    );
    expect(deps.loadConversationMessages).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("dispatches HYDRATION_COMPLETE even when wallet, config, stream settings, and autonomy replay all hang forever", async () => {
    const deps = makeDeps();
    const events: StartupEvent[] = [];

    // Must resolve quickly. If any hanging decoration is awaited before
    // HYDRATION_COMPLETE, this rejects on the timeout instead.
    await Promise.race([
      runHydrating(deps, (event) => events.push(event), { current: false }),
      new Promise((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "runHydrating blocked on non-critical shell decoration",
              ),
            ),
          3_000,
        ),
      ),
    ]);

    expect(events).toContainEqual({ type: "HYDRATION_COMPLETE" });
  });

  it("defers the wallet fetch off the ready critical path but still kicks it off", async () => {
    const deps = makeDeps();
    const events: StartupEvent[] = [];

    await runHydrating(deps, (event) => events.push(event), {
      current: false,
    });

    expect(events).toContainEqual({ type: "HYDRATION_COMPLETE" });
    // The fetch was started (background decoration)…
    expect(clientMock.getWalletAddresses).toHaveBeenCalledTimes(1);
    // …but since it never resolves, the setter must not have run by the time
    // hydration completed — proving the await is NOT on the critical path.
    expect(deps.setWalletAddresses).not.toHaveBeenCalled();
  });

  it("does not await the autonomy replay before completing hydration", async () => {
    const deps = makeDeps();
    const events: StartupEvent[] = [];

    await runHydrating(deps, (event) => events.push(event), {
      current: false,
    });

    expect(events).toContainEqual({ type: "HYDRATION_COMPLETE" });
    expect(deps.fetchAutonomyReplay).toHaveBeenCalledTimes(1);
  });
});
