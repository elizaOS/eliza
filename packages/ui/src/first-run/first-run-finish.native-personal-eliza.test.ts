/** Verifies companion Cloud onboarding binds the account-native personal Eliza without provisioning an agent row. */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunProfileDraft } from "./first-run";
import type { FirstRunFinishPorts } from "./first-run-finish";
import { listOrAutoProvisionCloudAgent } from "./first-run-finish";

const PERSONAL_ID = "personal:11111111-1111-4111-8111-111111111111";
const PERSONAL_BASE = `https://staging.elizacloud.ai/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`;

const clientMock = vi.hoisted(() => ({
  getPersonalSharedEliza: vi.fn(),
  getCloudCompatAgents: vi.fn(),
  selectOrProvisionCloudAgent: vi.fn(),
  getCloudStatus: vi.fn(async () => ({ connected: false })),
  getRestAuthToken: vi.fn(() => null as string | null),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));
const addAgentProfileMock = vi.hoisted(() => vi.fn(() => ({ id: "profile" })));
const saveActiveServerMock = vi.hoisted(() => vi.fn());
const saveFirstRunCompleteMock = vi.hoisted(() => vi.fn());
const persistMobileModeMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => ({ desktop: false }));

vi.mock("../api", () => ({ client: clientMock }));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => ({
    cloudApiBase: "https://staging.elizacloud.ai",
    preferSharedCloudTier: true,
  }),
}));

vi.mock("../platform/init", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/init")>()),
  isAndroid: false,
  isDesktopPlatform: () => platformMock.desktop,
  isIOS: true,
  isNative: true,
}));

vi.mock("../state", () => ({
  addAgentProfile: addAgentProfileMock,
  createPersistedActiveServer: vi.fn((server) => server),
  loadPersistedActiveServer: vi.fn(() => null),
  removeAgentProfile: vi.fn(),
  savePersistedActiveServer: saveActiveServerMock,
  savePersistedFirstRunComplete: saveFirstRunCompleteMock,
}));

vi.mock("./mobile-runtime-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mobile-runtime-mode")>()),
  persistMobileRuntimeModeForServerTarget: persistMobileModeMock,
}));

function draft(): FirstRunProfileDraft {
  return {
    agentName: "Eliza",
    runtime: "cloud",
    localInference: "cloud-inference",
    remoteApiBase: "",
    remoteToken: "",
  };
}

function ports(): FirstRunFinishPorts {
  return {
    uiLanguage: "en",
    elizaCloudConnected: true,
    handleInteractiveCloudLogin: vi.fn(async () => {}),
    setRuntimeState: vi.fn(),
    setTab: vi.fn(),
    completeFirstRun: vi.fn(),
    onStatus: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.desktop = false;
  window.localStorage.clear();
  window.localStorage.setItem("steward_session_token", "steward-token");
  clientMock.getPersonalSharedEliza.mockResolvedValue({
    agentId: PERSONAL_ID,
    agentName: "Eliza",
    apiBase: PERSONAL_BASE,
    runtime: "shared",
  });
});

describe("companion personal Eliza onboarding", () => {
  it.each([
    ["iOS", false],
    ["desktop", true],
  ])(
    "binds the same account identity on %s without listing or provisioning agents",
    async (_platform, desktop) => {
      platformMock.desktop = desktop;
      const p = ports();
      const outcome = await listOrAutoProvisionCloudAgent(draft(), p);

      expect(outcome).toEqual({ kind: "done" });
      expect(clientMock.getPersonalSharedEliza).toHaveBeenCalledWith({
        cloudApiBase: "https://staging.elizacloud.ai",
        authToken: "steward-token",
      });
      expect(clientMock.getCloudCompatAgents).not.toHaveBeenCalled();
      expect(clientMock.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
      expect(saveActiveServerMock).toHaveBeenCalledWith({
        id: `cloud:${PERSONAL_ID}`,
        kind: "cloud",
        label: "Eliza",
        apiBase: PERSONAL_BASE,
        accessToken: "steward-token",
      });
      expect(addAgentProfileMock).toHaveBeenCalledWith({
        kind: "cloud",
        label: "Eliza",
        cloudAgentId: PERSONAL_ID,
        apiBase: PERSONAL_BASE,
        accessToken: "steward-token",
      });
      expect(persistMobileModeMock).toHaveBeenCalledWith("elizacloud");
      expect(p.completeFirstRun).toHaveBeenCalledWith("chat");
    },
  );

  it("surfaces identity resolution failure without falling back to provisioning", async () => {
    clientMock.getPersonalSharedEliza.mockRejectedValueOnce(
      new Error("personal identity unavailable"),
    );

    await expect(
      listOrAutoProvisionCloudAgent(draft(), ports()),
    ).rejects.toThrow("personal identity unavailable");
    expect(clientMock.getCloudCompatAgents).not.toHaveBeenCalled();
    expect(clientMock.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });
});
