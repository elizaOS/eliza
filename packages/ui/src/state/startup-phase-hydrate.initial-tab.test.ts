// @vitest-environment jsdom

/**
 * Initial tab routing of the hydrating phase (#13371 / #14362): a root boot
 * lands on the default landing tab (chat) and never on character-select — there
 * is no automatic post-onboarding character-select landing; character
 * customization is reached explicitly from Settings/launcher. A deep-linked URL
 * still wins over the root landing. The client and every dep are doubled; only
 * the tab-routing tail is under test.
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
    fetchAutonomyReplay: vi.fn(async () => {}),
    setSelectedVrmIndex: vi.fn(),
    setWalletAddresses: vi.fn(),
    setTab: vi.fn(),
    setTabRaw: vi.fn(),
    initialTabSetRef: { current: false },
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
  it("a root boot lands on the default landing tab (chat) — never character-select (#13371 / #14362)", async () => {
    const deps = makeDeps();
    const events = await run(deps);

    expect(deps.setTab).toHaveBeenCalledTimes(1);
    expect(deps.setTab).toHaveBeenCalledWith("chat");
    expect(deps.setTab).not.toHaveBeenCalledWith("character-select");
    expect(deps.setTabRaw).not.toHaveBeenCalledWith("character-select");
    expect(deps.initialTabSetRef.current).toBe(true);
    expect(events).toContainEqual({ type: "HYDRATION_COMPLETE" });
  });

  it("a deep-linked URL wins: no root landing, the named tab is applied", async () => {
    setPath("/settings");
    const deps = makeDeps();
    await run(deps);

    expect(deps.setTab).not.toHaveBeenCalled();
    expect(deps.setTabRaw).toHaveBeenCalledWith("settings");
    expect(deps.setTabRaw).not.toHaveBeenCalledWith("character-select");
    expect(deps.initialTabSetRef.current).toBe(true);
  });

  it("a later hydrate (initial tab already set) never re-routes the root", async () => {
    const deps = makeDeps();
    deps.initialTabSetRef.current = true;
    await run(deps);

    expect(deps.setTab).not.toHaveBeenCalled();
  });
});
