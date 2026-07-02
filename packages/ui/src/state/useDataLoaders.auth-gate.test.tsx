// @vitest-environment jsdom
//
// #11084 — AppProvider mounts the data loaders before the auth probe
// resolves. The supportsFullAppShellRoutes-gated one-shot loaders (workbench
// overview, owner-name getConfig) must not issue a single request while the
// session is unauthenticated, and must fire once it flips to authenticated.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
    getWorkbenchOverview: vi.fn(async () => ({
      tasksAvailable: true,
      triggersAvailable: true,
      todosAvailable: true,
    })),
    getConfig: vi.fn(async () => ({ ui: { ownerName: "Owner" } })),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    getConversationMessages: vi.fn(async () => ({ messages: [] })),
  },
  auth: { authenticated: false },
}));

vi.mock("../api", () => ({ client: mocks.client }));

vi.mock("../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => mocks.auth.authenticated,
}));

import { type DataLoadersDeps, useDataLoaders } from "./useDataLoaders";

function makeDeps(overrides: Partial<DataLoadersDeps> = {}): DataLoadersDeps {
  const noop = () => {};
  return {
    autonomousStoreRef: { current: {} },
    autonomousEventsRef: { current: [] },
    autonomousLatestEventIdRef: { current: null },
    autonomousRunHealthByRunIdRef: { current: {} },
    autonomousReplayInFlightRef: { current: false },
    setAutonomousEvents: noop,
    setAutonomousLatestEventId: noop,
    setAutonomousRunHealthByRunId: noop,
    activeConversationIdRef: { current: null },
    conversationMessagesRef: { current: [] },
    greetingFiredRef: { current: false },
    setConversations: noop,
    setActiveConversationId: noop,
    setConversationMessages: noop,
    loadWalletConfig: async () => {},
    agentStatus: null,
    characterData: null,
    characterDraft: null,
    loadCharacter: async () => {},
    selectedVrmIndex: 0,
    firstRunComplete: false,
    uiLanguage: "en",
    setOwnerNameState: noop,
    ...overrides,
  } as unknown as DataLoadersDeps;
}

beforeEach(() => {
  mocks.client.getWorkbenchOverview.mockClear();
  mocks.client.getConfig.mockClear();
  mocks.auth.authenticated = false;
});

describe("useDataLoaders auth gate (#11084)", () => {
  it("loadWorkbench issues no request while unauthenticated, then loads after auth flips", async () => {
    const deps = makeDeps({
      agentStatus: { state: "running" } as DataLoadersDeps["agentStatus"],
    });
    const { result, rerender } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadWorkbench();
    });
    expect(mocks.client.getWorkbenchOverview).not.toHaveBeenCalled();
    expect(result.current.workbench).toBeNull();

    // The auth flip itself re-fires the workbench load that the pre-auth
    // agent-running edge suppressed.
    mocks.auth.authenticated = true;
    await act(async () => {
      rerender();
    });
    expect(mocks.client.getWorkbenchOverview).toHaveBeenCalledTimes(1);
  });

  it("owner-name getConfig hydration waits for authentication", async () => {
    const deps = makeDeps({
      agentStatus: { state: "running" } as DataLoadersDeps["agentStatus"],
    });
    const { rerender } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.client.getConfig).not.toHaveBeenCalled();

    mocks.auth.authenticated = true;
    await act(async () => {
      rerender();
    });
    expect(mocks.client.getConfig).toHaveBeenCalledTimes(1);
  });
});
