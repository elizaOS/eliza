// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type HydratingDeps, runHydrating } from "./startup-phase-hydrate";

const clientMock = vi.hoisted(() => ({
  connectWs: vi.fn(),
  getBaseUrl: vi.fn(() => "https://abc123.elizacloud.ai"),
  getWalletAddresses: vi.fn(async () => ({})),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

type TestHydratingDeps = HydratingDeps & {
  firstRunCompletionCommittedRef: { current: boolean };
  firstRunCompletionJustCommittedRef: { current: boolean };
};

function makeDeps(overrides: Partial<HydratingDeps> = {}): TestHydratingDeps {
  const deps: HydratingDeps = {
    setStartupError: vi.fn(),
    setFirstRunLoading: vi.fn(),
    hydrateInitialConversationState: vi.fn(async () => null),
    requestGreetingWhenRunningRef: { current: vi.fn(async () => {}) },
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
  return deps as TestHydratingDeps;
}

describe("runHydrating character-select launch handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("does not treat a persisted first-run completion as a fresh character-select handoff", async () => {
    const deps = makeDeps({
      firstRunCompletionCommittedRef: { current: true },
      firstRunCompletionJustCommittedRef: { current: false },
    });
    const dispatch = vi.fn();

    await runHydrating(deps, dispatch, { current: false });

    expect(deps.setTab).not.toHaveBeenCalledWith("character-select");
    expect(deps.setTab).toHaveBeenCalledWith("chat");
    expect(deps.firstRunCompletionCommittedRef.current).toBe(true);
    expect(deps.firstRunCompletionJustCommittedRef.current).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "HYDRATION_COMPLETE" });
  });

  it("consumes a just-committed first-run completion as a one-shot character-select handoff", async () => {
    const deps = makeDeps({
      firstRunCompletionCommittedRef: { current: true },
      firstRunCompletionJustCommittedRef: { current: true },
    });

    await runHydrating(deps, vi.fn(), { current: false });

    expect(deps.setTab).toHaveBeenCalledWith("character-select");
    expect(deps.firstRunCompletionJustCommittedRef.current).toBe(false);
    expect(deps.firstRunCompletionCommittedRef.current).toBe(false);
  });
});
