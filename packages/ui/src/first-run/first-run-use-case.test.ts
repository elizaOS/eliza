// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { client } = vi.hoisted(() => ({
  client: {
    getBaseUrl: vi.fn(() => ""),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
    submitFirstRun: vi.fn(async () => undefined),
    getCloudStatus: vi.fn(async () => ({ connected: true, reason: undefined })),
    getCloudCompatAgents: vi.fn(async () => ({ success: true, data: [] })),
    selectOrProvisionCloudAgent: vi.fn(async () => ({
      agentId: "agent-1",
      agentName: "Eliza",
      apiBase: "https://agent-1.elizacloud.ai",
      bridgeUrl: null,
      created: true,
    })),
  },
}));

vi.mock("../api", () => ({ client }));
vi.mock("../api/client-cloud", () => ({
  getCloudAuthToken: vi.fn(() => "cloud-token"),
  isDirectCloudSharedAgentBase: vi.fn(() => false),
}));
vi.mock("../api/app-shell-capabilities", () => ({
  supportsFullAppShellRoutes: vi.fn(() => true),
}));
vi.mock("../config/boot-config", () => ({
  getBootConfig: vi.fn(() => ({
    cloudApiBase: "https://www.elizacloud.ai",
    preferSharedCloudTier: false,
  })),
}));
vi.mock("../state", () => ({
  addAgentProfile: vi.fn(() => ({ id: "profile-1" })),
  createPersistedActiveServer: vi.fn((args: Record<string, unknown>) => ({
    label: "Cloud agent",
    apiBase: args.apiBase,
    accessToken: args.accessToken,
  })),
  savePersistedActiveServer: vi.fn(),
}));
vi.mock("../utils", () => ({
  isCloudStatusAuthenticated: vi.fn((connected: boolean) => connected),
  preOpenWindow: vi.fn(() => null),
}));
vi.mock("./use-first-run-controller", () => ({
  startLocalRuntime: vi.fn(async () => undefined),
  waitForAgentApi: vi.fn(async () => undefined),
}));
vi.mock("./voice-readiness", () => ({
  resolveFirstRunLocalAgentApiBase: vi.fn(() => "http://127.0.0.1:31337"),
}));
vi.mock("./auto-download-recommended", () => ({
  autoDownloadRecommendedLocalModelInBackground: vi.fn(),
}));

import type { FirstRunProfileDraft } from "./first-run";
import {
  beginCloudOAuth,
  chooseProvider,
  completeCloudProvisioning,
  type FirstRunPorts,
  finalizeFirstRun,
  routeOtherToSettings,
  runFirstRunRuntimeChoice,
} from "./first-run-use-case";

function makePorts(overrides: Partial<FirstRunPorts> = {}): FirstRunPorts {
  return {
    uiLanguage: "en",
    elizaCloudConnected: true,
    setState: vi.fn(),
    handleCloudLogin: vi.fn(async () => undefined),
    completeFirstRun: vi.fn(),
    showActionBanner: vi.fn(),
    setTab: vi.fn(),
    startTutorial: vi.fn(),
    onProgress: vi.fn(),
    ...overrides,
  };
}

const DRAFT: FirstRunProfileDraft = {
  agentName: "Eliza",
  runtime: "local",
  localInference: "all-local",
  remoteApiBase: "",
  remoteToken: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  client.getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
});

describe("runFirstRunRuntimeChoice", () => {
  it("routes local → the provider sub-choice with the on-device default", async () => {
    const step = await runFirstRunRuntimeChoice(makePorts(), "local", {
      ...DRAFT,
      runtime: "local",
    });
    expect(step.kind).toBe("choice");
    if (step.kind !== "choice") throw new Error("expected choice");
    expect(step.choice.id).toBe("provider");
    expect(step.choice.options.map((o) => o.value)).toEqual([
      "provider:on-device",
      "provider:elizacloud",
    ]);
  });

  it("routes other → Settings handoff", async () => {
    const ports = makePorts();
    const step = await runFirstRunRuntimeChoice(ports, "other", DRAFT);
    expect(step.kind).toBe("prompt");
    expect(ports.setTab).toHaveBeenCalledWith("settings");
    expect(ports.completeFirstRun).toHaveBeenCalledWith("settings");
  });
});

describe("beginCloudOAuth", () => {
  it("auto-provisions when the account has zero agents (exactly one POST)", async () => {
    const ports = makePorts();
    const step = await beginCloudOAuth(ports, { ...DRAFT, runtime: "cloud" });
    expect(step.kind).toBe("done");
    expect(client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(client.submitFirstRun).toHaveBeenCalledTimes(1);
  });

  it("offers the agent picker when ≥1 agents exist", async () => {
    client.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        {
          agent_id: "a1",
          agent_name: "Existing",
          node_id: null,
          container_id: null,
          status: "running",
          created_at: "2026-01-01",
        },
      ],
    } as never);
    const step = await beginCloudOAuth(makePorts(), {
      ...DRAFT,
      runtime: "cloud",
    });
    expect(step.kind).toBe("choice");
    if (step.kind !== "choice") throw new Error("expected choice");
    expect(step.choice.id).toBe("agent");
    const values = step.choice.options.map((o) => o.value);
    expect(values).toContain("agent:a1");
    expect(values).toContain("agent:new");
    // The picker does NOT provision yet.
    expect(client.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });

  it("runs the OAuth gate when not connected, then errors+retries on failure", async () => {
    client.getCloudStatus.mockResolvedValue({
      connected: false,
      reason: undefined,
    });
    const ports = makePorts({ elizaCloudConnected: false });
    // getCloudAuthToken is mocked to a truthy token, so resolveCloudConnection
    // would pass; force the token-less path by re-mocking.
    const cloud = await import("../api/client-cloud");
    vi.mocked(cloud.getCloudAuthToken).mockReturnValueOnce(null);
    const step = await beginCloudOAuth(ports, { ...DRAFT, runtime: "cloud" });
    expect(ports.handleCloudLogin).toHaveBeenCalledTimes(1);
    expect(step.kind).toBe("error");
  });
});

describe("completeCloudProvisioning", () => {
  it("provisions a preferred agent and persists it", async () => {
    const ports = makePorts();
    const step = await completeCloudProvisioning(
      ports,
      { ...DRAFT, runtime: "cloud" },
      {
        preferAgentId: "a1",
      },
    );
    expect(step.kind).toBe("done");
    expect(client.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preferAgentId: "a1" }),
    );
    expect(ports.onProgress).toHaveBeenLastCalledWith(null);
  });

  it("force-creates a new agent on demand", async () => {
    await completeCloudProvisioning(
      makePorts(),
      { ...DRAFT, runtime: "cloud" },
      {
        forceCreate: true,
      },
    );
    expect(client.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({ forceCreate: true }),
    );
  });
});

describe("chooseProvider", () => {
  it("on-device starts the local agent and submits once", async () => {
    const ports = makePorts();
    const step = await chooseProvider(ports, DRAFT, "on-device");
    expect(step.kind).toBe("done");
    expect(client.submitFirstRun).toHaveBeenCalledTimes(1);
  });

  it("elizacloud (hybrid) connects cloud before local setup", async () => {
    const ports = makePorts({ elizaCloudConnected: true });
    const step = await chooseProvider(ports, DRAFT, "elizacloud");
    expect(step.kind).toBe("done");
    expect(ports.setState).toHaveBeenCalledWith(
      "firstRunRuntimeTarget",
      "elizacloud-hybrid",
    );
  });
});

describe("routeOtherToSettings / finalizeFirstRun", () => {
  it("opens settings and completes first-run there", () => {
    const ports = makePorts();
    const step = routeOtherToSettings(ports);
    expect(step.kind).toBe("prompt");
    expect(ports.setTab).toHaveBeenCalledWith("settings");
  });

  it("starts the tutorial only when the user takes it", () => {
    const take = makePorts();
    finalizeFirstRun(take, true);
    expect(take.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
    expect(take.startTutorial).toHaveBeenCalledTimes(1);

    const skip = makePorts();
    finalizeFirstRun(skip, false);
    expect(skip.startTutorial).not.toHaveBeenCalled();
  });
});
