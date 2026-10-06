/** Real startup poll/reducer/storage and recovery; only API responses are controlled. */
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  getFirstRunStatus: vi.fn(),
  getStatus: vi.fn(),
  hasToken: vi.fn(() => true),
  getBaseUrl: vi.fn(() => "https://paired-fixture.example"),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));
vi.mock("@elizaos/ui", async (original) => ({
  ...(await original<typeof import("@elizaos/ui")>()),
  client: api,
  isAndroid: false,
  isIOS: false,
}));

import {
  getActiveProfile,
  upsertAndActivateAgentProfile,
} from "../../../../ui/src/state/agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../../../../ui/src/state/persistence";
import {
  type StartupState,
  startupReducer,
} from "../../../../ui/src/state/startup-coordinator";
import {
  type PollingBackendDeps,
  runPollingBackend,
} from "./startup-phase-poll";
import type { RestoringSessionCtx } from "./startup-phase-restore";
import {
  recoverTerminalStartupError,
  type StartupCoordinatorDeps,
} from "./useStartupCoordinator";

const server = {
  id: "remote:fixture",
  kind: "remote" as const,
  label: "Saved host",
  apiBase: "https://paired-fixture.example",
  accessToken: "fixture-paired-bearer",
};
const deps: PollingBackendDeps = {
  setStartupError: vi.fn(),
  setAuthRequired: vi.fn(),
  setFirstRunComplete: vi.fn(),
  setFirstRunLoading: vi.fn(),
  setFirstRunOptions: vi.fn(),
  setFirstRunRuntimeTarget: vi.fn(),
  setFirstRunProvider: vi.fn(),
  setFirstRunRemoteConnected: vi.fn(),
  setFirstRunRemoteApiBase: vi.fn(),
  setFirstRunRemoteToken: vi.fn(),
  setFirstRunCloudProvisionedContainer: vi.fn(),
  setPairingEnabled: vi.fn(),
  setPairingExpiresAt: vi.fn(),
  firstRunCompletionCommittedRef: { current: false },
  uiLanguage: "en",
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  api.hasToken.mockReturnValue(true);
  api.getAuthStatus.mockRejectedValue(
    Object.assign(new Error("Host offline"), {
      kind: "network",
      path: "/api/auth/status",
    }),
  );
  upsertAndActivateAgentProfile({
    kind: "remote",
    label: server.label,
    apiBase: server.apiBase,
    accessToken: server.accessToken,
  });
  savePersistedActiveServer(server);
  savePersistedFirstRunComplete(true);
  localStorage.setItem("eliza:mobile-runtime-mode", "remote-mac");
  localStorage.setItem(
    "eliza:chat:activeConversationId",
    "original-conversation",
  );
  localStorage.setItem("eliza:chat:draft:original-conversation", "Owner draft");
});
afterEach(() => vi.restoreAllMocks());

it.each([
  { hadPriorFirstRun: true, paired: false },
  { hadPriorFirstRun: false, paired: true },
  { hadPriorFirstRun: false, paired: false },
])(
  "keeps a saved remote outage retryable without falling back to local: %j",
  async ({ hadPriorFirstRun, paired }) => {
    api.hasToken.mockReturnValue(paired);
    savePersistedFirstRunComplete(hadPriorFirstRun);
    let state: StartupState = {
      phase: "polling-backend",
      target: "remote-backend",
      attempts: 0,
    };
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: server,
      restoredActiveServer: server,
      shouldPreserveCompletedFirstRun: true,
      hadPriorFirstRun,
    };
    const snapshot = Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    );
    const dispatch = (event: Parameters<typeof startupReducer>[1]) => {
      state = startupReducer(state, event);
    };
    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: false,
        backendTimeoutMs: 1,
        agentReadyTimeoutMs: 1,
        probeForExistingInstall: false,
        defaultTarget: null,
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "remote-backend",
    );
    expect(state.phase).toBe("error");
    expect(api.setBaseUrl).not.toHaveBeenCalled();
    expect(api.setToken).not.toHaveBeenCalled();
    expect(loadPersistedActiveServer()).toEqual(server);
    expect(getActiveProfile()?.accessToken).toBe(server.accessToken);
    expect(
      Object.fromEntries(
        Object.keys(localStorage).map((key) => [
          key,
          localStorage.getItem(key),
        ]),
      ),
    ).toEqual(snapshot);
    const recoveryDeps = {
      ...deps,
      setAgentStatus: vi.fn(),
      setConnected: vi.fn(),
    } as unknown as StartupCoordinatorDeps;
    api.getStatus.mockRejectedValueOnce(Error("Still offline"));
    expect(
      await recoverTerminalStartupError(recoveryDeps, dispatch, {
        current: false,
      }),
    ).toBe(false);
    expect(recoveryDeps.setConnected).not.toHaveBeenCalled();
    api.getStatus.mockResolvedValue({ state: "running" });
    api.getFirstRunStatus.mockResolvedValue({ complete: true });
    expect(
      await recoverTerminalStartupError(recoveryDeps, dispatch, {
        current: false,
      }),
    ).toBe(true);
    expect(state.phase).toBe("hydrating");
    expect(recoveryDeps.setConnected).toHaveBeenCalledWith(true);
    expect(loadPersistedActiveServer()).toEqual(server);
    expect(
      Object.fromEntries(
        Object.keys(localStorage).map((key) => [
          key,
          localStorage.getItem(key),
        ]),
      ),
    ).toEqual(snapshot);
  },
);

it.each([true, false])(
  "retains an explicit remote with pairing disabled and no bearer (prior setup: %s)",
  async (hadPriorFirstRun) => {
    localStorage.clear();
    const { accessToken: _token, ...selected } = server;
    upsertAndActivateAgentProfile({
      kind: "remote",
      label: selected.label,
      apiBase: selected.apiBase,
    });
    savePersistedActiveServer(selected);
    savePersistedFirstRunComplete(hadPriorFirstRun);
    localStorage.setItem("eliza:mobile-runtime-mode", "remote-mac");
    localStorage.setItem(
      "eliza:chat:activeConversationId",
      "original-conversation",
    );
    localStorage.setItem(
      "eliza:chat:draft:original-conversation",
      "Owner draft",
    );
    api.hasToken.mockReturnValue(false);
    api.getAuthStatus.mockResolvedValue({
      required: true,
      authenticated: false,
      pairingEnabled: false,
      passwordConfigured: false,
      expiresAt: null,
    });
    const snapshot = Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    );
    let state: StartupState = {
      phase: "polling-backend",
      target: "remote-backend",
      attempts: 0,
    };
    await runPollingBackend(
      deps,
      (event) => {
        state = startupReducer(state, event);
      },
      {
        supportsLocalRuntime: false,
        backendTimeoutMs: 100,
        agentReadyTimeoutMs: 100,
        probeForExistingInstall: false,
        defaultTarget: null,
      },
      {
        persistedActiveServer: selected,
        restoredActiveServer: selected,
        shouldPreserveCompletedFirstRun: hadPriorFirstRun,
        hadPriorFirstRun,
      },
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "remote-backend",
    );
    expect(state.phase).toBe("pairing-required");
    expect(deps.setAuthRequired).toHaveBeenCalledWith(true);
    expect(deps.setPairingEnabled).toHaveBeenCalledWith(false);
    expect(deps.setFirstRunComplete).not.toHaveBeenCalled();
    expect(api.setBaseUrl).not.toHaveBeenCalled();
    expect(api.setToken).not.toHaveBeenCalled();
    expect(loadPersistedActiveServer()).toEqual(selected);
    expect(getActiveProfile()?.accessToken).toBeUndefined();
    expect(
      Object.fromEntries(
        Object.keys(localStorage).map((key) => [
          key,
          localStorage.getItem(key),
        ]),
      ),
    ).toEqual(snapshot);
  },
);
