// @vitest-environment jsdom

/**
 * Regression for #15310 failure mode #3 and the #15901/#15902/#15903 landing
 * contract of `bindCloudAgent`. The handoff branch was once gated on
 * `selectedAgent.created`, so a re-login that REUSED an existing shared agent
 * (`created:false` — e.g. after a failed first run) never re-entered the
 * upgrade path and stranded the user on the shared adapter.
 *
 * Contract under test:
 *   - created:true                          → handoff fires (unchanged)
 *   - created:false, no pending marker      → handoff fires (#15310 #3)
 *   - created:false, marker for THIS agent  → handoff does NOT fire here —
 *     resumePendingCloudHandoff owns the interrupted-but-live migration and is
 *     invoked at the landing (it verifies the target and re-arms a fresh
 *     create itself when the target is dead); double-firing would provision a
 *     second dedicated agent.
 *   - created:false, marker for a DIFFERENT agent → the stale marker is
 *     cleared and a fresh handoff fires (#15902: a leftover marker must not
 *     suppress the upgrade path or pin the provisioning tile).
 *   - a reused agent that already OWNS a dedicated container (bridgeUrl set)
 *     never mints another dedicated target (#15902 run-2 class).
 *   - EVERY successful landing persists the durable completion flag
 *     (`eliza:first-run-complete`) headlessly (#15903).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPendingCloudHandoff,
  savePendingCloudHandoff,
} from "../cloud/handoff/pending-handoff-store";
import type { FirstRunProfileDraft } from "./first-run";
import type { FirstRunFinishPorts } from "./first-run-finish";
import {
  bindCloudAgent,
  listOrAutoProvisionCloudAgent,
  readActiveCloudAgentId,
  runFirstRunFinish,
} from "./first-run-finish";

const SHARED_AGENT_BASE =
  "https://staging.elizacloud.ai/api/v1/eliza/agents/cad3c071";

const clientMock = vi.hoisted(() => ({
  selectOrProvisionCloudAgent: vi.fn(),
  submitFirstRun: vi.fn(async () => {}),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
  getBaseUrl: vi.fn(() => ""),
  createCloudCompatAgent: vi.fn(),
  startCloudAgentHandoff: vi.fn(),
  deleteSharedBridgeAgent: vi.fn(async () => ({ success: true })),
  getCloudCompatAgents: vi.fn(),
  getCloudStatus: vi.fn(async () => null),
  getRestAuthToken: vi.fn(() => null as string | null),
}));

const runCloudAgentHandoffMock = vi.hoisted(() => vi.fn());
const resumePendingCloudHandoffMock = vi.hoisted(() => vi.fn(() => true));
const savePersistedFirstRunCompleteMock = vi.hoisted(() => vi.fn());
const silentlyRepointToDedicatedMock = vi.hoisted(() => vi.fn());
const runAgentSessionRecoveryMock = vi.hoisted(() => vi.fn());
const removeAgentProfileMock = vi.hoisted(() => vi.fn());
const loadPersistedActiveServerMock = vi.hoisted(() =>
  vi.fn<() => { kind: string; id?: string } | null>(() => null),
);

vi.mock("../api", () => ({ client: clientMock }));

vi.mock("../cloud/handoff/silent-repoint", () => ({
  silentlyRepointToDedicated: silentlyRepointToDedicatedMock,
}));

vi.mock("../state/agent-session-recovery-runner", () => ({
  runAgentSessionRecovery: runAgentSessionRecoveryMock,
}));

vi.mock("../cloud/handoff/run-cloud-agent-handoff", () => ({
  runCloudAgentHandoff: runCloudAgentHandoffMock,
}));

vi.mock("../cloud/handoff/resume-pending-handoff", () => ({
  resumePendingCloudHandoff: resumePendingCloudHandoffMock,
}));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => ({
    cloudApiBase: "https://staging.elizacloud.ai",
    preferSharedCloudTier: true,
  }),
}));

vi.mock("../state", () => ({
  addAgentProfile: vi.fn(() => ({ id: "profile-1" })),
  createPersistedActiveServer: vi.fn((v) => ({ label: "Eliza Cloud", ...v })),
  loadPersistedActiveServer: loadPersistedActiveServerMock,
  removeAgentProfile: removeAgentProfileMock,
  savePersistedActiveServer: vi.fn(),
  savePersistedFirstRunComplete: savePersistedFirstRunCompleteMock,
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

function ports(): FirstRunFinishPorts {
  return {
    uiLanguage: "en",
    elizaCloudConnected: true,
    handleCloudLogin: vi.fn(async () => {}),
    setRuntimeState: vi.fn(),
    setTab: vi.fn(),
    completeFirstRun: vi.fn(),
    onStatus: vi.fn(),
  };
}

function mockSelection(
  created: boolean,
  opts: { bridgeUrl?: string | null; requiresAgentPairing?: boolean } = {},
): void {
  clientMock.selectOrProvisionCloudAgent.mockResolvedValue({
    agentId: "cad3c071",
    apiBase: SHARED_AGENT_BASE,
    bridgeUrl: opts.bridgeUrl ?? null,
    requiresAgentPairing: opts.requiresAgentPairing ?? false,
    created,
  });
}

function seedMarker(sharedAgentId: string): void {
  savePendingCloudHandoff({
    sharedAgentId,
    dedicatedAgentId: "dedicated-1",
    sharedApiBase: SHARED_AGENT_BASE,
    cloudApiBase: "https://staging.elizacloud.ai",
    startedAt: Date.now(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("shared→dedicated handoff firing on shared-agent completion", () => {
  it("fires for a newly created shared agent (unchanged behavior)", async () => {
    mockSelection(true);
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(outcome.kind).toBe("done");
    expect(runCloudAgentHandoffMock).toHaveBeenCalledTimes(1);
  });

  it("fires for a REUSED shared agent with no pending marker (#15310 #3)", async () => {
    mockSelection(false);
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(outcome.kind).toBe("done");
    expect(runCloudAgentHandoffMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire when a marker for THIS agent exists — the resume path is invoked instead", async () => {
    seedMarker("cad3c071");
    mockSelection(false);
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(outcome.kind).toBe("done");
    expect(runCloudAgentHandoffMock).not.toHaveBeenCalled();
    // The interrupted migration is resumed AT the landing, not left for a
    // later boot's 404 path to notice (#15902).
    expect(resumePendingCloudHandoffMock).toHaveBeenCalledTimes(1);
    expect(loadPendingCloudHandoff()?.sharedAgentId).toBe("cad3c071");
  });

  it("clears a stale marker for a DIFFERENT agent and fires a fresh handoff (#15902)", async () => {
    seedMarker("some-other-shared-agent");
    mockSelection(false);
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(outcome.kind).toBe("done");
    expect(loadPendingCloudHandoff()).toBeNull();
    expect(runCloudAgentHandoffMock).toHaveBeenCalledTimes(1);
    expect(resumePendingCloudHandoffMock).not.toHaveBeenCalled();
  });

  it("never mints another dedicated target for a reused agent that already owns one (bridgeUrl set)", async () => {
    mockSelection(false, { bridgeUrl: "https://cad3c071.elizacloud.ai" });
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(outcome.kind).toBe("done");
    expect(runCloudAgentHandoffMock).not.toHaveBeenCalled();
    expect(clientMock.createCloudCompatAgent).not.toHaveBeenCalled();
  });
});

describe("durable first-run completion at the landing (#15903)", () => {
  it("persists eliza:first-run-complete on the fresh-provision landing", async () => {
    mockSelection(true);
    await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(savePersistedFirstRunCompleteMock).toHaveBeenCalledWith(true);
  });

  it("persists eliza:first-run-complete on the returning-account reuse landing", async () => {
    mockSelection(false, { bridgeUrl: "https://cad3c071.elizacloud.ai" });
    const p = ports();
    await bindCloudAgent(draft(), "steward-token", {}, p);
    // The headless persist must not depend on the conductor's completion
    // callback chain — it fires before/with completeFirstRun.
    expect(savePersistedFirstRunCompleteMock).toHaveBeenCalledWith(true);
    expect(p.completeFirstRun).toHaveBeenCalledWith("chat");
  });

  it("persists eliza:first-run-complete before the pair relay unloads the session (navigate mode)", async () => {
    mockSelection(false, { requiresAgentPairing: true });
    runAgentSessionRecoveryMock.mockResolvedValueOnce({
      ok: true,
      mode: "navigate",
    });
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(outcome.kind).toBe("handoff-started");
    expect(savePersistedFirstRunCompleteMock).toHaveBeenCalledWith(true);
  });

  it("persists eliza:first-run-complete and completes in-process when pairing resolves without a redirect", async () => {
    mockSelection(false, { requiresAgentPairing: true });
    runAgentSessionRecoveryMock.mockResolvedValueOnce({
      ok: true,
      mode: "in-process",
    });
    const p = ports();
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, p);
    expect(outcome.kind).toBe("done");
    expect(savePersistedFirstRunCompleteMock).toHaveBeenCalledWith(true);
    expect(p.completeFirstRun).toHaveBeenCalledWith("chat");
  });

  it("does not persist completion when pairing itself fails", async () => {
    mockSelection(false, { requiresAgentPairing: true });
    runAgentSessionRecoveryMock.mockResolvedValueOnce({
      ok: false,
      message: "device rejected pairing",
    });
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(outcome.kind).toBe("error");
    expect(savePersistedFirstRunCompleteMock).not.toHaveBeenCalled();
  });
});

describe("readActiveCloudAgentId", () => {
  it("returns null when no active server is persisted", () => {
    loadPersistedActiveServerMock.mockReturnValueOnce(null);
    expect(readActiveCloudAgentId()).toBeNull();
  });

  it("returns null for a non-cloud active server", () => {
    loadPersistedActiveServerMock.mockReturnValueOnce({
      kind: "local",
      id: "local:1",
    });
    expect(readActiveCloudAgentId()).toBeNull();
  });

  it("extracts the agent id from a cloud:<id> active server", () => {
    loadPersistedActiveServerMock.mockReturnValueOnce({
      kind: "cloud",
      id: "cloud:cad3c071",
    });
    expect(readActiveCloudAgentId()).toBe("cad3c071");
  });

  it("rejects a malformed id containing a slash", () => {
    loadPersistedActiveServerMock.mockReturnValueOnce({
      kind: "cloud",
      id: "cloud:cad3c071/extra",
    });
    expect(readActiveCloudAgentId()).toBeNull();
  });
});

describe("listOrAutoProvisionCloudAgent / runFirstRunFinish routing", () => {
  beforeEach(() => {
    window.localStorage.setItem("steward_session_token", "steward-jwt");
  });

  it("lists running agents and binds the preferred one (routed via runFirstRunFinish)", async () => {
    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        { agent_id: "cad3c071", status: "running", preferred: true },
        { agent_id: "other", status: "running" },
      ],
    });
    mockSelection(false);
    const outcome = await runFirstRunFinish(
      { ...draft(), runtime: "cloud" },
      ports(),
    );
    expect(outcome.kind).toBe("done");
    expect(clientMock.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preferAgentId: "cad3c071" }),
    );
  });

  it("surfaces the listing error when the agent list call fails", async () => {
    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: false,
      error: "network unreachable",
    });
    const outcome = await listOrAutoProvisionCloudAgent(draft(), ports());
    expect(outcome).toEqual({ kind: "error", message: "network unreachable" });
  });

  it("requires cloud login when no auth token is available", async () => {
    window.localStorage.clear();
    const p = ports();
    p.elizaCloudConnected = false;
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("needs-cloud-login");
  });
});
