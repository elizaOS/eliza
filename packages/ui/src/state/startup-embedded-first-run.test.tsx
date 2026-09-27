/**
 * Verifies desktop startup gating for an embedded agent whose first-run has
 * not completed (#30744): a restored target that resolves to the shell's own
 * embedded API is classified embedded-local, and a renderer-cached first-run
 * completion never presents the ready UI over a backend that reports
 * first-run incomplete with its runtime deferred. The startup poller and
 * reducer are real; the agent API is a deterministic test double, so this is
 * integration coverage rather than packaged-app evidence.
 */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  getFirstRunStatus: vi.fn(),
  getFirstRunOptions: vi.fn(),
  getConfig: vi.fn(),
  getStatus: vi.fn(),
  hasToken: vi.fn(() => false),
  getBaseUrl: vi.fn(() => "http://127.0.0.1:31338"),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));

vi.mock("../api", () => ({ client: clientMock }));

vi.mock("../api/android-native-agent-transport", () => ({
  getAndroidLocalAgentBootStateForUrl: vi.fn(async () => ({
    state: "unknown",
  })),
  requestAndroidLocalAgentStartForUrl: vi.fn(async () => false),
}));

vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isAndroid: false,
  isIOS: false,
}));

import type { PersistedActiveServer } from "./persistence";
import {
  createDesktopPolicy,
  type StartupEvent,
  type StartupState,
  startupReducer,
} from "./startup-coordinator";
import {
  type PollingBackendDeps,
  runPollingBackend,
} from "./startup-phase-poll";
import {
  isDesktopEmbeddedApiBase,
  type RestoringSessionCtx,
  resolveDesktopRestoredTarget,
} from "./startup-phase-restore";

const EMBEDDED_BASE = "http://127.0.0.1:31338";

function createPollingDeps(committed: boolean): PollingBackendDeps {
  return {
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
    firstRunCompletionCommittedRef: { current: committed },
    uiLanguage: "en",
  };
}

async function pollOnce(
  deps: PollingBackendDeps,
  ctx: RestoringSessionCtx,
  target: "embedded-local" | "remote-backend",
): Promise<StartupEvent[]> {
  const events: StartupEvent[] = [];
  await runPollingBackend(
    deps,
    (event) => events.push(event),
    { ...createDesktopPolicy(), backendTimeoutMs: 5_000 },
    ctx,
    1,
    { current: 1 },
    { current: false },
    { current: null },
    target,
  );
  return events;
}

describe("desktop embedded first-run startup gating (#30744)", () => {
  const staleRemoteRecord: PersistedActiveServer = {
    id: "remote:loopback",
    kind: "remote",
    label: "Local agent",
    apiBase: "http://127.0.0.1:31337",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clientMock.getBaseUrl.mockReturnValue(EMBEDDED_BASE);
    clientMock.hasToken.mockReturnValue(false);
    clientMock.getAuthStatus.mockResolvedValue({
      required: false,
      authenticated: false,
      pairingEnabled: false,
      expiresAt: null,
    });
    clientMock.getFirstRunStatus.mockResolvedValue({ complete: false });
    clientMock.getStatus.mockResolvedValue({ state: "not_started" });
    clientMock.getFirstRunOptions.mockResolvedValue({
      names: [],
      styles: [],
      providers: [],
      cloudProviders: [],
      models: { small: [], large: [] },
      inventoryProviders: [],
      sharedStyleRules: "",
    });
    clientMock.getConfig.mockResolvedValue({});
  });

  it("routes a cached completion over an unconfigured embedded backend to first-run, not ready", async () => {
    // Renderer storage still says onboarding completed and a restored record
    // exists, but the restore recorded no prior first-run for this backend.
    const deps = createPollingDeps(true);
    const events = await pollOnce(
      deps,
      {
        persistedActiveServer: staleRemoteRecord,
        restoredActiveServer: staleRemoteRecord,
        shouldPreserveCompletedFirstRun: false,
        hadPriorFirstRun: false,
      },
      "embedded-local",
    );

    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.firstRunCompletionCommittedRef.current).toBe(false);
    expect(deps.setFirstRunComplete).toHaveBeenLastCalledWith(false);
    expect(events).toEqual([
      { type: "BACKEND_REACHED", firstRunComplete: false },
    ]);
    const state = startupReducer(
      { phase: "polling-backend", target: "embedded-local", attempts: 0 },
      events[0] as StartupEvent,
    );
    expect(state).toMatchObject({
      phase: "first-run-required",
      serverReachable: true,
      target: "embedded-local",
    });
  });

  it("keeps a cached completion when the backend runtime is already running", async () => {
    clientMock.getStatus.mockResolvedValue({ state: "running" });
    const deps = createPollingDeps(true);
    const events = await pollOnce(
      deps,
      {
        persistedActiveServer: staleRemoteRecord,
        restoredActiveServer: staleRemoteRecord,
        shouldPreserveCompletedFirstRun: true,
        hadPriorFirstRun: false,
      },
      "embedded-local",
    );

    expect(deps.firstRunCompletionCommittedRef.current).toBe(true);
    expect(events).toEqual([
      { type: "BACKEND_REACHED", firstRunComplete: true },
    ]);
    let state: StartupState = startupReducer(
      { phase: "polling-backend", target: "embedded-local", attempts: 0 },
      events[0] as StartupEvent,
    );
    expect(state).toMatchObject({ phase: "starting-runtime" });
    state = startupReducer(state, { type: "AGENT_RUNNING" });
    expect(state.phase).toBe("hydrating");
  });

  it("classifies a restored remote record on the shell's embedded API as embedded-local", () => {
    expect(isDesktopEmbeddedApiBase(EMBEDDED_BASE, EMBEDDED_BASE)).toBe(true);
    expect(
      isDesktopEmbeddedApiBase("http://127.0.0.1:31337", EMBEDDED_BASE),
    ).toBe(false);
    expect(
      isDesktopEmbeddedApiBase("https://agent.example.com", EMBEDDED_BASE),
    ).toBe(false);
    expect(isDesktopEmbeddedApiBase(EMBEDDED_BASE, null)).toBe(false);

    const base = {
      serverKind: "remote" as const,
      clientBaseUrl: EMBEDDED_BASE,
      liveApiBase: EMBEDDED_BASE,
    };
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        target: "remote-backend",
        shellRuntimeMode: "local",
      }),
    ).toBe("embedded-local");
    // An external-mode shell does not host the embedded agent.
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        target: "remote-backend",
        shellRuntimeMode: "external",
      }),
    ).toBe("remote-backend");
    // Unknown shell mode (bridge timeout) keeps the persisted classification.
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        target: "remote-backend",
        shellRuntimeMode: undefined,
      }),
    ).toBe("remote-backend");
    // A remote on another host is never reclassified.
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        clientBaseUrl: "https://agent.example.com",
        target: "remote-backend",
        shellRuntimeMode: "local",
      }),
    ).toBe("remote-backend");
    // Existing external-mode downgrade of a loopback "local" record.
    expect(
      resolveDesktopRestoredTarget({
        ...base,
        serverKind: "local",
        target: "embedded-local",
        shellRuntimeMode: "external",
      }),
    ).toBe("remote-backend");
  });
});
