/**
 * Desktop credential-publication race in the startup auth gate (#33034
 * follow-up). Real startup poller, real reducer, and the real Electrobun
 * runtime detection through its window marker; the agent API client and the
 * token publication event are deterministic doubles, so this is integration
 * coverage of the poll's decision, not packaged-desktop evidence.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  getFirstRunStatus: vi.fn(),
  getFirstRunOptions: vi.fn(),
  getConfig: vi.fn(),
  getStatus: vi.fn(),
  getCloudCompatAgent: vi.fn(),
  getCloudCompatAgents: vi.fn(),
  hasToken: vi.fn(() => false),
  getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
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

vi.mock("../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => false,
}));

import type { StartupEvent } from "./startup-coordinator";
import type { PollingBackendDeps } from "./startup-phase-poll";
import { runPollingBackend } from "./startup-phase-poll";

const ELECTROBUN_WINDOW_ID = 7;
const LOCAL_BASE = "http://127.0.0.1:31337";

function createPollingDeps(): PollingBackendDeps {
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
    firstRunCompletionCommittedRef: { current: false },
    uiLanguage: "en",
  };
}

function publishDesktopCredential(): void {
  clientMock.hasToken.mockReturnValue(true);
  // The same DOM event the desktop bridge publishes and the api client
  // consumes to repoint base + bearer.
  window.dispatchEvent(
    new CustomEvent("eliza:desktop-api-base-updated", {
      detail: { previousBase: null, base: LOCAL_BASE },
    }),
  );
}

async function runPoll(backendTimeoutMs: number): Promise<StartupEvent[]> {
  const events: StartupEvent[] = [];
  await runPollingBackend(
    createPollingDeps(),
    (event) => events.push(event),
    {
      supportsLocalRuntime: true,
      backendTimeoutMs,
      agentReadyTimeoutMs: backendTimeoutMs,
      probeForExistingInstall: true,
      defaultTarget: "embedded-local",
    },
    null,
    1,
    { current: 1 },
    { current: false },
    { current: null },
  );
  return events;
}

const UNAUTHENTICATED = {
  required: true,
  authenticated: false,
  pairingEnabled: true,
  expiresAt: null as number | null,
};

describe("startup auth gate vs the desktop token publication race", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.hasToken.mockReturnValue(false);
    clientMock.getBaseUrl.mockReturnValue(LOCAL_BASE);
    clientMock.getFirstRunStatus.mockResolvedValue({
      complete: true,
      cloudProvisioned: false,
    });
    (window as unknown as Record<string, unknown>).__electrobunWindowId =
      ELECTROBUN_WINDOW_ID;
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__electrobunWindowId;
  });

  it("waits for the apiBaseUpdate publication instead of dead-ending on the pairing gate", async () => {
    clientMock.getAuthStatus.mockImplementationOnce(async () => {
      // The native push lands after the first unauthenticated probe — the
      // exact ordering the review harness measured on the desktop shell.
      setTimeout(publishDesktopCredential, 20);
      return { ...UNAUTHENTICATED };
    });
    clientMock.getAuthStatus.mockResolvedValue({
      required: true,
      authenticated: true,
      pairingEnabled: true,
      expiresAt: null,
    });

    const events = await runPoll(5_000);

    expect(events).toEqual([
      { type: "BACKEND_REACHED", firstRunComplete: true },
    ]);
  });

  it("still reaches the auth gate after one deadline-bounded wait when no publication ever lands", async () => {
    clientMock.getAuthStatus.mockResolvedValue({ ...UNAUTHENTICATED });

    const startedAt = Date.now();
    const events = await runPoll(300);
    const elapsed = Date.now() - startedAt;

    expect(events).toEqual([{ type: "BACKEND_AUTH_REQUIRED" }]);
    // The one-shot wait must actually consume the poll's remaining deadline
    // before falling through — the pre-repair behavior exited immediately.
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it("keeps the immediate pairing gate on plain web runtimes", async () => {
    delete (window as unknown as Record<string, unknown>).__electrobunWindowId;
    clientMock.getAuthStatus.mockResolvedValue({ ...UNAUTHENTICATED });

    const startedAt = Date.now();
    const events = await runPoll(5_000);
    const elapsed = Date.now() - startedAt;

    expect(events).toEqual([{ type: "BACKEND_AUTH_REQUIRED" }]);
    expect(elapsed).toBeLessThan(200);
  });
});
