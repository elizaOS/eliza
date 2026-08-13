/**
 * Verifies the managed-native cold-boot handoff from startup classification to
 * one authenticated in-process recovery transaction. The startup poller,
 * reducer, recovery hook, runner, and storage commit are real; the agent API,
 * Cloud HTTP responses, and Capacitor platform are deterministic test doubles,
 * so this is integration coverage rather than real-device evidence.
 */
// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  getFirstRunStatus: vi.fn(),
  getFirstRunOptions: vi.fn(),
  getConfig: vi.fn(),
  getCloudCompatAgent: vi.fn(),
  getCloudCompatAgents: vi.fn(),
  hasToken: vi.fn(() => true),
  getBaseUrl: vi.fn(() => "https://agent-123.cloud.eliza.app"),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));

const cloudTokenMock = vi.hoisted(() =>
  vi.fn(() => "steward.jwt.native-session" as string | null),
);

vi.mock("../api", () => ({ client: clientMock }));

vi.mock("../api/client-cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client-cloud")>()),
  getCloudAuthToken: cloudTokenMock,
}));

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

import { getBootConfig, setBootConfig } from "../config/boot-config";
import { useAgentSessionRecovery } from "../hooks/useAgentSessionRecovery";
import { getActiveProfile, loadAgentProfileRegistry } from "./agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import {
  type StartupEvent,
  type StartupState,
  startupReducer,
} from "./startup-coordinator";
import type { PollingBackendDeps } from "./startup-phase-poll";
import { runPollingBackend } from "./startup-phase-poll";
import type { RestoringSessionCtx } from "./startup-phase-restore";

const originalFetch = globalThis.fetch;
const originalCapacitor = (globalThis as Record<string, unknown>).Capacitor;
const originalBootConfig = getBootConfig();
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const AGENT_BASE = `https://${AGENT_ID}.cloud.eliza.app`;

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

function RecoveryProbe(props: {
  onRecovered: () => void;
  onStatus: (status: string) => void;
}) {
  const status = useAgentSessionRecovery({
    active: true,
    reason: "remote_auth_required",
    onRecovered: props.onRecovered,
  });
  props.onStatus(status);
  return null;
}

describe("managed-native stale-session cold boot", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
    };
    setBootConfig({
      ...originalBootConfig,
      cloudApiBase: "https://eliza.app",
    });
    clientMock.hasToken.mockReturnValue(true);
    clientMock.getBaseUrl.mockReturnValue(AGENT_BASE);
    clientMock.getAuthStatus.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), {
        kind: "http",
        status: 401,
        path: "/api/auth/status",
      }),
    );
    cloudTokenMock.mockReturnValue("steward.jwt.native-session");
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    setBootConfig(originalBootConfig);
    if (originalCapacitor === undefined) {
      delete (globalThis as Record<string, unknown>).Capacitor;
    } else {
      (globalThis as Record<string, unknown>).Capacitor = originalCapacitor;
    }
  });

  it("advances out of startup, exchanges once, and atomically replaces every stale bearer mirror", async () => {
    const activeServer = {
      id: `cloud:${AGENT_ID}`,
      kind: "cloud" as const,
      label: "Dedicated agent",
      apiBase: AGENT_BASE,
      accessToken: "stale-agent-bearer",
    };
    savePersistedActiveServer(activeServer);
    // Exercise the real legacy-active-server migration so the recovery commit
    // must update both the active-server record and its active profile.
    expect(loadAgentProfileRegistry().profiles).toHaveLength(1);

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init: RequestInit | undefined) => {
        const url = String(input);
        if (url.endsWith(`/api/v1/eliza/agents/${AGENT_ID}/pairing-token`)) {
          return new Response(
            JSON.stringify({
              data: {
                redirectUrl: `${AGENT_BASE}/pair?token=one-time-native`,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "https://api.eliza.app/api/auth/pair/native") {
          return new Response(
            JSON.stringify({
              apiKey: "fresh-agent-bearer",
              agentId: AGENT_ID,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        throw new Error(`Unexpected recovery request: ${url}`);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pollingDeps = createPollingDeps();
    const startupEvents: StartupEvent[] = [];
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: activeServer,
      restoredActiveServer: activeServer,
      shouldPreserveCompletedFirstRun: true,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      pollingDeps,
      (event) => startupEvents.push(event),
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1_000,
        agentReadyTimeoutMs: 1_000,
        probeForExistingInstall: true,
        defaultTarget: "cloud-managed",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(startupEvents).toEqual([
      { type: "BACKEND_REACHED", firstRunComplete: true },
    ]);
    let startupState: StartupState = {
      phase: "polling-backend",
      target: "cloud-managed",
      attempts: 0,
    };
    startupState = startupReducer(startupState, startupEvents[0]);
    expect(startupState).toMatchObject({
      phase: "starting-runtime",
      target: "cloud-managed",
    });
    startupState = startupReducer(startupState, { type: "AGENT_RUNNING" });
    startupState = startupReducer(startupState, {
      type: "HYDRATION_COMPLETE",
    });
    expect(startupState).toEqual({ phase: "ready" });

    const statuses: string[] = [];
    const onRecovered = vi.fn();
    render(
      <RecoveryProbe
        onRecovered={onRecovered}
        onStatus={(status) => statuses.push(status)}
      />,
    );

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });

    expect(statuses).toContain("recovering");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clientMock.setToken).toHaveBeenCalledWith("fresh-agent-bearer");
    // The durable pair token is persisted under the per-agent key (#17579);
    // the legacy global key must stay empty so another agent's boot can never
    // adopt this credential.
    expect(localStorage.getItem(`eliza:cloud-pair:api-token:${AGENT_ID}`)).toBe(
      "fresh-agent-bearer",
    );
    expect(
      sessionStorage.getItem(`eliza:cloud-pair:api-token:${AGENT_ID}`),
    ).toBe("fresh-agent-bearer");
    expect(localStorage.getItem("eliza:cloud-pair:api-token")).toBeNull();
    expect(sessionStorage.getItem("eliza:cloud-pair:api-token")).toBeNull();
    expect(loadPersistedActiveServer()?.accessToken).toBe("fresh-agent-bearer");
    expect(getActiveProfile()?.accessToken).toBe("fresh-agent-bearer");

    const nativeExchange = fetchMock.mock.calls[1];
    const exchangeInit = nativeExchange?.[1] as RequestInit | undefined;
    expect(exchangeInit?.headers).toMatchObject({
      Authorization: "Bearer steward.jwt.native-session",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(exchangeInit?.body))).toEqual({
      token: "one-time-native",
      agentId: AGENT_ID,
      expectedOrigin: AGENT_BASE,
    });
  });
});
