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
