/** Verifies Cloud first-run binds the rowless account identity without provisioning compute. */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunProfileDraft } from "./first-run";
import type { FirstRunFinishPorts } from "./first-run-finish";
import {
  bindCloudAgent,
  listOrAutoProvisionCloudAgent,
} from "./first-run-finish";

const SHARED_AGENT_ID = "23766030-c096-4a14-932a-a4e43c562432";
const SHARED_AGENT_BASE = `https://staging.elizacloud.ai/api/v1/eliza/agents/${SHARED_AGENT_ID}`;

const clientStub = vi.hoisted(() => ({
  getPersonalSharedEliza: vi.fn(),
  selectOrProvisionCloudAgent: vi.fn(),
  submitFirstRun: vi.fn(async () => {}),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
  getBaseUrl: vi.fn(() => ""),
  createCloudCompatAgent: vi.fn(),
  startCloudAgentHandoff: vi.fn(),
  deleteSharedBridgeAgent: vi.fn(async () => ({ success: true })),
  getCloudStatus: vi.fn(async () => ({ connected: false })),
  getRestAuthToken: vi.fn(() => null as string | null),
  listConversations: vi.fn(async () => ({ conversations: [] })) as
    | ReturnType<typeof vi.fn>
    | undefined,
}));

const runCloudAgentHandoffStub = vi.hoisted(() => vi.fn());
const resumePendingCloudHandoffStub = vi.hoisted(() => vi.fn(() => true));
const savePersistedFirstRunCompleteStub = vi.hoisted(() => vi.fn());
const silentlyRepointToDedicatedStub = vi.hoisted(() => vi.fn());
const runAgentSessionRecoveryStub = vi.hoisted(() => vi.fn());
const removeAgentProfileStub = vi.hoisted(() => vi.fn());
const addAgentProfileStub = vi.hoisted(() =>
  vi.fn(() => ({ id: "profile-1" })),
);
const loadPersistedActiveServerStub = vi.hoisted(() =>
  vi.fn<() => { kind: string; id?: string } | null>(() => null),
);

vi.mock("../api", () => ({ client: clientStub }));

vi.mock("../cloud/handoff/silent-repoint", () => ({
  silentlyRepointToDedicated: silentlyRepointToDedicatedStub,
}));

vi.mock("../state/agent-session-recovery-runner", () => ({
  runAgentSessionRecovery: runAgentSessionRecoveryStub,
}));

vi.mock("../cloud/handoff/run-cloud-agent-handoff", () => ({
  runCloudAgentHandoff: runCloudAgentHandoffStub,
}));

vi.mock("../cloud/handoff/resume-pending-handoff", () => ({
  resumePendingCloudHandoff: resumePendingCloudHandoffStub,
}));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => ({
    cloudApiBase: "https://staging.elizacloud.ai",
    preferSharedCloudTier: true,
  }),
}));

vi.mock("../state", () => ({
  addAgentProfile: addAgentProfileStub,
  createPersistedActiveServer: vi.fn((v) => ({ label: "Eliza Cloud", ...v })),
  loadPersistedActiveServer: loadPersistedActiveServerStub,
  removeAgentProfile: removeAgentProfileStub,
  savePersistedActiveServer: vi.fn(),
  savePersistedFirstRunComplete: savePersistedFirstRunCompleteStub,
}));

vi.mock("./mobile-runtime-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mobile-runtime-mode")>()),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
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

function ports(overrides: Partial<FirstRunFinishPorts> = {}): {
  ports: FirstRunFinishPorts;
  handleInteractiveCloudLogin: ReturnType<typeof vi.fn>;
} {
  const handleInteractiveCloudLogin = vi.fn(async () => {});
  return {
    ports: {
      uiLanguage: "en",
      elizaCloudConnected: false,
      handleInteractiveCloudLogin,
      setRuntimeState: vi.fn(),
      setTab: vi.fn(),
      completeFirstRun: vi.fn(),
      onStatus: vi.fn(),
      ...overrides,
    },
    handleInteractiveCloudLogin,
  };
}

function storeStewardToken(token = "steward-jwt"): void {
  window.localStorage.setItem("steward_session_token", token);
}

function stubSelection(): void {
  clientStub.selectOrProvisionCloudAgent.mockResolvedValue({
    agentId: SHARED_AGENT_ID,
    agentName: "Eliza",
    apiBase: SHARED_AGENT_BASE,
    bridgeUrl: `https://${SHARED_AGENT_ID}.elizacloud.ai`,
    requiresAgentPairing: false,
    created: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  clientStub.listConversations = vi.fn(async () => ({ conversations: [] }));
  clientStub.getCloudStatus.mockResolvedValue({ connected: false });
  clientStub.getPersonalSharedEliza.mockResolvedValue({
    personalElizaId: SHARED_AGENT_ID,
    agentId: SHARED_AGENT_ID,
    activeAgentId: SHARED_AGENT_ID,
    agentName: "Eliza",
    apiBase: SHARED_AGENT_BASE,
    runtime: "shared",
  });
  stubSelection();
});

describe("listOrAutoProvisionCloudAgent — rowless personal Eliza", () => {
  it("binds the personal identity directly when a bearer is already present", async () => {
    storeStewardToken();
    const { ports: p } = ports();
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("done");
    expect(clientStub.getCloudStatus).not.toHaveBeenCalled();
    expect(clientStub.getPersonalSharedEliza).toHaveBeenCalledTimes(1);
    expect(clientStub.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });

  it("lands a new interactive bearer without any agent-list or status probe", async () => {
    const { ports: p, handleInteractiveCloudLogin } = ports();
    handleInteractiveCloudLogin.mockImplementation(async () => {
      storeStewardToken("fresh-jwt");
    });
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("done");
    expect(handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
    expect(clientStub.getCloudStatus).not.toHaveBeenCalled();
    expect(clientStub.getPersonalSharedEliza).toHaveBeenCalledWith({
      cloudApiBase: "https://staging.elizacloud.ai",
      authToken: "fresh-jwt",
    });
    expect(clientStub.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });

  it("returns needs-cloud-login when interactive auth lands no bearer", async () => {
    const { ports: p, handleInteractiveCloudLogin } = ports();
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("needs-cloud-login");
    expect(handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
    expect(clientStub.getCloudStatus).not.toHaveBeenCalled();
    expect(clientStub.getPersonalSharedEliza).not.toHaveBeenCalled();
    expect(clientStub.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });
});

describe("bindCloudAgent — agent-base warm-up", () => {
  it("persists the authoritative Cloud agent owner with its profile credential", async () => {
    const outcome = await bindCloudAgent(
      draft(),
      "steward-token",
      {},
      ports().ports,
    );

    expect(outcome.kind).toBe("done");
    expect(addAgentProfileStub).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        cloudAgentId: SHARED_AGENT_ID,
        apiBase: SHARED_AGENT_BASE,
        accessToken: "steward-token",
      }),
    );
  });

  it("fires a fire-and-forget conversations fetch on the just-bound base so the post-ready hydrate hits a warm container", async () => {
    const outcome = await bindCloudAgent(
      draft(),
      "steward-token",
      {},
      ports().ports,
    );
    expect(outcome.kind).toBe("done");
    expect(clientStub.setBaseUrl).toHaveBeenCalledWith(SHARED_AGENT_BASE);
    expect(clientStub.listConversations).toHaveBeenCalledTimes(1);
  });

  it("a hanging or rejecting warm-up never blocks or fails the bind", async () => {
    clientStub.listConversations = vi.fn(
      () => Promise.reject(new Error("cold container")) as never,
    );
    const outcome = await bindCloudAgent(
      draft(),
      "steward-token",
      {},
      ports().ports,
    );
    expect(outcome.kind).toBe("done");
  });

  it("a client shim without the chat surface is a safe no-op", async () => {
    clientStub.listConversations = undefined;
    const outcome = await bindCloudAgent(
      draft(),
      "steward-token",
      {},
      ports().ports,
    );
    expect(outcome.kind).toBe("done");
  });
});
