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
 *  2. After `handleCloudLogin` lands a bearer, no post-login status re-probe
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

const SHARED_AGENT_BASE =
  "https://staging.elizacloud.ai/api/v1/eliza/agents/cad3c071";

const RUNNING_AGENT = {
  agent_id: "cad3c071",
  agent_name: "Eliza",
  status: "running",
  created_at: "2026-07-01T00:00:00Z",
};

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
  getCloudStatus: vi.fn(async () => ({ connected: false })),
  getRestAuthToken: vi.fn(() => null as string | null),
  listConversations: vi.fn(async () => ({ conversations: [] })) as
    | ReturnType<typeof vi.fn>
    | undefined,
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

function ports(overrides: Partial<FirstRunFinishPorts> = {}): {
  ports: FirstRunFinishPorts;
  handleCloudLogin: ReturnType<typeof vi.fn>;
} {
  const handleCloudLogin = vi.fn(async () => {});
  return {
    ports: {
      uiLanguage: "en",
      elizaCloudConnected: false,
      handleCloudLogin,
      setRuntimeState: vi.fn(),
      setTab: vi.fn(),
      completeFirstRun: vi.fn(),
      onStatus: vi.fn(),
      ...overrides,
    },
    handleCloudLogin,
  };
}

function storeStewardToken(token = "steward-jwt"): void {
  window.localStorage.setItem("steward_session_token", token);
}

function mockSelection(): void {
  clientMock.selectOrProvisionCloudAgent.mockResolvedValue({
    agentId: "cad3c071",
    agentName: "Eliza",
    apiBase: SHARED_AGENT_BASE,
    bridgeUrl: "https://cad3c071.elizacloud.ai",
    requiresAgentPairing: false,
    created: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  clientMock.listConversations = vi.fn(async () => ({ conversations: [] }));
  clientMock.getCloudStatus.mockResolvedValue({ connected: false });
  clientMock.getCloudCompatAgents.mockResolvedValue({
    success: true,
    data: [RUNNING_AGENT],
  });
  mockSelection();
});

describe("listOrAutoProvisionCloudAgent — no serial status probe before the agents list", () => {
  it("with a stored bearer: skips getCloudStatus entirely, fetches the agents list ONCE, and reuses it as knownAgents for the bind", async () => {
    storeStewardToken();
    const { ports: p } = ports();
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("done");
    // The user/status probe is OFF the chain — the agents list is the probe.
    expect(clientMock.getCloudStatus).not.toHaveBeenCalled();
    // Exactly one list fetch, no duplicate in the bind.
    expect(clientMock.getCloudCompatAgents).toHaveBeenCalledTimes(1);
    expect(clientMock.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(
      clientMock.selectOrProvisionCloudAgent.mock.calls[0][0].knownAgents,
    ).toEqual([RUNNING_AGENT]);
  });

  it("stale bearer degrade: a failed list falls back to the status probe and re-enters login instead of stranding", async () => {
    storeStewardToken("stale-jwt");
    clientMock.getCloudCompatAgents
      .mockResolvedValueOnce({ success: false, data: [], error: "401" })
      .mockResolvedValueOnce({ success: true, data: [RUNNING_AGENT] });
    const { ports: p, handleCloudLogin } = ports();
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("done");
    // The failure path consulted the status probe (legacy semantics kept)…
    expect(clientMock.getCloudStatus).toHaveBeenCalled();
    // …and re-entered login rather than treating the dead list as connected.
    expect(handleCloudLogin).toHaveBeenCalledTimes(1);
    expect(clientMock.getCloudCompatAgents).toHaveBeenCalledTimes(2);
  });

  it("after handleCloudLogin lands a bearer there is NO post-login status re-probe — one probe total on the no-token entry", async () => {
    const { ports: p, handleCloudLogin } = ports();
    handleCloudLogin.mockImplementation(async () => {
      storeStewardToken("fresh-jwt");
    });
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("done");
    expect(handleCloudLogin).toHaveBeenCalledTimes(1);
    // Exactly ONE status probe (the pre-login connectivity check). The old
    // code issued a second one after login whose result was overridden by the
    // token check anyway — that serial round trip must not come back.
    expect(clientMock.getCloudStatus).toHaveBeenCalledTimes(1);
    expect(clientMock.getCloudCompatAgents).toHaveBeenCalledTimes(1);
  });

  it("returns needs-cloud-login when login lands no token and the probe stays disconnected", async () => {
    const { ports: p, handleCloudLogin } = ports();
    const outcome = await listOrAutoProvisionCloudAgent(draft(), p);
    expect(outcome.kind).toBe("needs-cloud-login");
    expect(handleCloudLogin).toHaveBeenCalledTimes(1);
    // Pre-login probe + post-login probe (no token landed, so the probe is
    // still the only evidence available).
    expect(clientMock.getCloudStatus).toHaveBeenCalledTimes(2);
    expect(clientMock.getCloudCompatAgents).not.toHaveBeenCalled();
  });
});

describe("bindCloudAgent — agent-base warm-up", () => {
  it("fires a fire-and-forget conversations fetch on the just-bound base so the post-ready hydrate hits a warm container", async () => {
    const outcome = await bindCloudAgent(
      draft(),
      "steward-token",
      {},
      ports().ports,
    );
    expect(outcome.kind).toBe("done");
    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(SHARED_AGENT_BASE);
    expect(clientMock.listConversations).toHaveBeenCalledTimes(1);
  });

  it("a hanging or rejecting warm-up never blocks or fails the bind", async () => {
    clientMock.listConversations = vi.fn(
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
    clientMock.listConversations = undefined;
    const outcome = await bindCloudAgent(
      draft(),
      "steward-token",
      {},
      ports().ports,
    );
    expect(outcome.kind).toBe("done");
  });
});
