// @vitest-environment jsdom

/**
 * Initial tab routing of the hydrating phase (#13371 / #13396): the
 * character-select landing keys on the SESSION-scoped just-committed ref, so
 * a cold boot at the app root — where the DURABLE completion ref is seeded
 * true from the persisted flag (#11506) — lands on the default tab, never on
 * character-select; the landing fires exactly once right after a live
 * completion; and a deep-linked URL wins over the root landing. The client
 * and every dep are doubled; only the tab-routing tail is under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupEvent } from "./startup-coordinator";

const clientMock = vi.hoisted(() => ({
  connectWs: vi.fn(),
  getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
  getWalletAddresses: vi.fn(async () => ({}) as Record<string, never>),
  getConfig: vi.fn(async () => ({}) as Record<string, never>),
  getStreamSettings: vi.fn(async () => ({ settings: {} })),
}));

vi.mock("../api", () => ({ client: clientMock }));
vi.mock("../components/apps/load-apps-catalog", () => ({
  prefetchAppsCatalog: vi.fn(async () => undefined),
}));

import { type HydratingDeps, runHydrating } from "./startup-phase-hydrate";

function makeDeps(
  overrides: Partial<
    Pick<
      HydratingDeps,
      "firstRunCompletionCommittedRef" | "firstRunCompletionJustCommittedRef"
    >
  > = {},
): HydratingDeps {
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
    fetchAutonomyReplay: vi.fn(async () => {}),
    setSelectedVrmIndex: vi.fn(),
    setWalletAddresses: vi.fn(),
    setTab: vi.fn(),
    setTabRaw: vi.fn(),
    firstRunCompletionCommittedRef: { current: false },
    firstRunCompletionJustCommittedRef: { current: false },
    initialTabSetRef: { current: false },
    ...overrides,
  };
}

async function run(deps: HydratingDeps): Promise<StartupEvent[]> {
  const events: StartupEvent[] = [];
  await runHydrating(deps, (event) => events.push(event), { current: false });
  return events;
}

function setPath(path: string): void {
  window.history.replaceState(null, "", path);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  setPath("/");
});

describe("runHydrating initial tab routing", () => {
  it("an ordinary root boot lands on the default tab — never character-select — even with the DURABLE completion ref seeded true (#13371)", async () => {
    const deps = makeDeps({
      firstRunCompletionCommittedRef: { current: true },
    });
    const events = await run(deps);

    expect(deps.setTab).toHaveBeenCalledTimes(1);
    expect(deps.setTab).not.toHaveBeenCalledWith("character-select");
    expect(deps.setTabRaw).not.toHaveBeenCalledWith("character-select");
    expect(deps.initialTabSetRef.current).toBe(true);
    expect(events).toContainEqual({ type: "HYDRATION_COMPLETE" });
  });

  it("the boot right after a live completion lands on character-select ONCE and clears both refs (#13396)", async () => {
    const deps = makeDeps({
      firstRunCompletionCommittedRef: { current: true },
      firstRunCompletionJustCommittedRef: { current: true },
    });
    await run(deps);

    expect(deps.setTab).toHaveBeenCalledWith("character-select");
    expect(deps.firstRunCompletionJustCommittedRef.current).toBe(false);
    expect(deps.firstRunCompletionCommittedRef.current).toBe(false);
  });

  it("a deep-linked URL wins: no root landing, the named tab is applied", async () => {
    setPath("/settings");
    const deps = makeDeps();
    await run(deps);

    expect(deps.setTab).not.toHaveBeenCalled();
    expect(deps.setTabRaw).toHaveBeenCalledWith("settings");
    expect(deps.initialTabSetRef.current).toBe(true);
  });

  it("a later hydrate (initial tab already set) never re-routes the root", async () => {
    const deps = makeDeps();
    deps.initialTabSetRef.current = true;
    await run(deps);

    expect(deps.setTab).not.toHaveBeenCalled();
  });
});
