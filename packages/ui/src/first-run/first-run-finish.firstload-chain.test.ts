/** Verifies listOrAutoProvisionCloudAgent — no serial status probe before the agents list through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Regression for the post-login first-load resolution chain (first-5 strike,
 * FIRSTLOAD-REAL-2026-07-22). On staging the canary's post-token stall was a
 * SERIAL chain: /api/v1/user status probe (~0.8s) → /api/v1/eliza/agents
 * (~1.8s) → bind → cold agent-base /api/auth/me (~2.3s). Three structural
 * invariants pin the fix (structural, not timing-based, so they cannot flake):
 *
 *  1. A stored bearer skips the /api/v1/user status probe entirely — the
 *     agents list IS the connectivity probe, and its result is REUSED as
 *     `knownAgents` for the bind (exactly one list fetch, zero status probes).
 *  2. After `handleInteractiveCloudLogin` lands a bearer, no post-login status re-probe
 *     runs — the token is the proof; the probe only runs when no token landed.
 *  3. The bind warms the just-bound agent base with a fire-and-forget
 *     conversations fetch so the post-ready hydrate hits a warm container —
 *     and a client shim without that chat surface is a safe no-op.
 *
 * The stale-token degrade (list fails → status probe → login re-entry) is
 * pinned too, so the fast path can never strand a revoked session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunProfileDraft } from "./first-run";
import type { FirstRunFinishPorts } from "./first-run-finish";
import {
  bindCloudAgent,
  listOrAutoProvisionCloudAgent,
} from "./first-run-finish";

const SHARED_AGENT_ID = "23766030-c096-4a14-932a-a4e43c562432";
const SHARED_AGENT_BASE = `https://staging.elizacloud.ai/api/v1/eliza/agents/${SHARED_AGENT_ID}`;

const RUNNING_AGENT = {
  agent_id: SHARED_AGENT_ID,
  agent_name: "Eliza",
  status: "running",
  created_at: "2026-07-01T00:00:00Z",
};

const clientStub = vi.hoisted(() => ({
  selectOrProvisionCloudAgent: vi.fn(),
  submitFirstRun: vi.fn(async () => {}),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
  getBaseUrl: vi.fn(() => ""),
  createCloudCompatAgent: vi.fn(),
  startCloudAgentHandoff: vi.fn(),
  deleteSharedBridgeAgent: vi.fn(async () => ({ success: true })),
  getCloudCompatAgents: vi.fn(),
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
  clientStub.getCloudCompatAgents.mockResolvedValue({
    success: true,
    data: [RUNNING_AGENT],
  });
  stubSelection();
});

describe("listOrAutoProvisionCloudAgent — no serial status probe before the agents list", () => {
  it("with a stored bearer: skips getCloudStatus entirely, fetches the agents list ONCE, and reuses it as knownAgents for the bind", async () => {
    storeStewardToken();
    const { ports: p } = ports();
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("done");
    // The user/status probe is OFF the chain — the agents list is the probe.
    expect(clientStub.getCloudStatus).not.toHaveBeenCalled();
    // Exactly one list fetch, no duplicate in the bind.
    expect(clientStub.getCloudCompatAgents).toHaveBeenCalledTimes(1);
    expect(clientStub.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(
      clientStub.selectOrProvisionCloudAgent.mock.calls[0][0].knownAgents,
    ).toEqual([RUNNING_AGENT]);
  });

  it("stale bearer degrade: a failed list falls back to the status probe and re-enters login instead of stranding", async () => {
    storeStewardToken("stale-jwt");
    clientStub.getCloudCompatAgents
      .mockResolvedValueOnce({ success: false, data: [], error: "401" })
      .mockResolvedValueOnce({ success: true, data: [RUNNING_AGENT] });
    const { ports: p, handleInteractiveCloudLogin } = ports();
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("done");
    // The failure path consulted the status probe (legacy semantics kept)…
    expect(clientStub.getCloudStatus).toHaveBeenCalled();
    // …and re-entered login rather than treating the dead list as connected.
    expect(handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
    expect(clientStub.getCloudCompatAgents).toHaveBeenCalledTimes(2);
  });

  it("after handleInteractiveCloudLogin lands a bearer there is NO post-login status re-probe — one probe total on the no-token entry", async () => {
    const { ports: p, handleInteractiveCloudLogin } = ports();
    handleInteractiveCloudLogin.mockImplementation(async () => {
      storeStewardToken("fresh-jwt");
    });
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("done");
    expect(handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
    // Exactly ONE status probe (the pre-login connectivity check). The old
    // code issued a second one after login whose result was overridden by the
    // token check anyway — that serial round trip must not come back.
    expect(clientStub.getCloudStatus).toHaveBeenCalledTimes(1);
    expect(clientStub.getCloudCompatAgents).toHaveBeenCalledTimes(1);
  });

  it("returns needs-cloud-login when login lands no token and the probe stays disconnected", async () => {
    const { ports: p, handleInteractiveCloudLogin } = ports();
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("needs-cloud-login");
    expect(handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
    // Pre-login probe + post-login probe (no token landed, so the probe is
    // still the only evidence available).
    expect(clientStub.getCloudStatus).toHaveBeenCalledTimes(2);
    expect(clientStub.getCloudCompatAgents).not.toHaveBeenCalled();
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
