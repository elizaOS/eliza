import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunOptions } from "../api";
import {
  type PollingBackendDeps,
  runPollingBackend,
} from "./startup-phase-poll";
import type { RestoringSessionCtx } from "./startup-phase-restore";

const clientMock = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  getFirstRunStatus: vi.fn(),
  getFirstRunOptions: vi.fn(),
  getConfig: vi.fn(),
  hasToken: vi.fn(),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return {
    ...actual,
    getBackendStartupTimeoutMs: () => 1000,
    scanProviderCredentials: vi.fn(async () => []),
  };
});

vi.mock("@elizaos/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/shared")>();
  return {
    ...actual,
    getStylePresets: () => [],
  };
});

function firstRunOptions(): FirstRunOptions {
  return {
    names: [],
    styles: [],
    providers: [],
    cloudProviders: [],
    models: {
      nano: [],
      small: [],
      medium: [],
      large: [],
      mega: [],
    },
    inventoryProviders: [],
    sharedStyleRules: "",
  };
}

function createDeps(): PollingBackendDeps {
  return {
    setStartupError: vi.fn(),
    setAuthRequired: vi.fn(),
    setFirstRunComplete: vi.fn(),
    setFirstRunLoading: vi.fn(),
    setFirstRunOptions: vi.fn(),
    setSetupStep: vi.fn(),
    setFirstRunRuntimeTarget: vi.fn(),
    setFirstRunCloudApiKey: vi.fn(),
    setFirstRunProvider: vi.fn(),
    setFirstRunVoiceProvider: vi.fn(),
    setFirstRunApiKey: vi.fn(),
    setFirstRunPrimaryModel: vi.fn(),
    setFirstRunOpenRouterModel: vi.fn(),
    setFirstRunRemoteConnected: vi.fn(),
    setFirstRunRemoteApiBase: vi.fn(),
    setFirstRunRemoteToken: vi.fn(),
    setFirstRunSmallModel: vi.fn(),
    setFirstRunLargeModel: vi.fn(),
    setFirstRunCloudProvisionedContainer: vi.fn(),
    setPairingEnabled: vi.fn(),
    setPairingExpiresAt: vi.fn(),
    applyDetectedProviders: vi.fn(),
    firstRunCompletionCommittedRef: { current: false },
    uiLanguage: "en",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMock.getAuthStatus.mockResolvedValue({
    required: false,
    pairingEnabled: false,
    expiresAt: null,
  });
  clientMock.getFirstRunStatus.mockResolvedValue({
    complete: false,
    cloudProvisioned: false,
  });
  clientMock.getFirstRunOptions.mockResolvedValue(firstRunOptions());
  clientMock.getConfig.mockResolvedValue({});
  clientMock.hasToken.mockReturnValue(false);
});

describe("runPollingBackend", () => {
  it("does not let stale persisted first-run completion override an incomplete backend", async () => {
    const deps = createDeps();
    const dispatch = vi.fn();
    const ctx: RestoringSessionCtx = {
      persistedActiveServer: null,
      restoredActiveServer: {
        id: "local:desktop",
        kind: "local",
        label: "Local agent",
        apiBase: "http://127.0.0.1:34137",
      },
      shouldPreserveCompletedFirstRun: true,
      hadPriorFirstRun: true,
    };

    await runPollingBackend(
      deps,
      dispatch,
      {
        supportsLocalRuntime: true,
        backendTimeoutMs: 1000,
        agentReadyTimeoutMs: 1000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
      ctx,
      1,
      { current: 1 },
      { current: false },
      { current: null },
    );

    expect(deps.setFirstRunComplete).toHaveBeenCalledWith(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "BACKEND_REACHED",
      firstRunComplete: false,
    });
  });
});
