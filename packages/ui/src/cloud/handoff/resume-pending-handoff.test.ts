// @vitest-environment jsdom

/**
 * Boot-time resume of a persisted shared→dedicated cloud-agent handoff that was
 * interrupted by a reload. Collaborators (the handoff supervisor, bridge
 * delete, cloud auth, runtime state) are doubled so the test drives the
 * decision logic deterministically: same dedicated target on resume, repoint +
 * bridge-delete on success, no delete on failure, and stale-marker clearing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HandoffResult = {
  status: "switched" | "switched-empty" | "failed" | "timed-out";
  imported: number;
  error?: string;
};

const mocks = vi.hoisted(() => ({
  startCloudAgentHandoff: vi.fn(
    async (_opts: Record<string, unknown>): Promise<HandoffResult> => ({
      status: "switched",
      imported: 1,
    }),
  ),
  deleteSharedBridgeAgent: vi.fn(async () => ({ success: true as const })),
  getCloudAuthToken: vi.fn((): string | null => "cloud-token"),
  isDirectCloudSharedAgentBase: vi.fn((base: string) =>
    base.includes("/api/v1/eliza/agents/"),
  ),
  loadPersistedActiveServer: vi.fn((): Record<string, unknown> | null => null),
  runAgentSessionRecovery: vi.fn<
    (_opts?: unknown) => Promise<{
      ok: true;
      redirectUrl: string;
      mode: "navigate" | "in-process";
    }>
  >(async (_opts?: unknown) => ({
    ok: true,
    redirectUrl: "https://dedicated-1.elizacloud.ai/pair?token=pairing",
    mode: "navigate",
  })),
  getCloudCompatAgent: vi.fn(async (_id: string) => ({
    success: true as boolean,
    data: { id: "dedicated-1", status: "provisioning" },
  })),
  createCloudCompatAgent: vi.fn(async (_opts: Record<string, unknown>) => ({
    success: true as boolean,
    data: {
      agentId: "dedicated-fresh",
      agentName: "Eliza",
      jobId: "job-fresh",
      status: "provisioning",
      nodeId: null,
      message: "ok",
    },
  })),
  silentlyRepointToDedicated: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: {
    startCloudAgentHandoff: mocks.startCloudAgentHandoff,
    deleteSharedBridgeAgent: mocks.deleteSharedBridgeAgent,
    getCloudCompatAgent: mocks.getCloudCompatAgent,
    createCloudCompatAgent: mocks.createCloudCompatAgent,
  },
}));

vi.mock("../../api/client-cloud", () => ({
  getCloudAuthToken: mocks.getCloudAuthToken,
  isDirectCloudSharedAgentBase: mocks.isDirectCloudSharedAgentBase,
}));

// resume-pending-handoff imports loadPersistedActiveServer directly from the
// persistence leaf (not the ../../state barrel) since #15411 broke the
// state/index → AppContext → startup-poll → resume cycle; mock that exact path.
vi.mock("../../state/persistence", () => ({
  loadPersistedActiveServer: mocks.loadPersistedActiveServer,
}));

vi.mock("../../state/agent-session-recovery-runner", () => ({
  runAgentSessionRecovery: mocks.runAgentSessionRecovery,
}));

vi.mock("./silent-repoint", () => ({
  silentlyRepointToDedicated: mocks.silentlyRepointToDedicated,
}));

import {
  loadPendingCloudHandoff,
  PENDING_HANDOFF_TTL_MS,
  type PendingCloudHandoff,
  savePendingCloudHandoff,
} from "./pending-handoff-store";
import {
  __resetResumeForTests,
  resumePendingCloudHandoff,
} from "./resume-pending-handoff";

const SHARED_BASE = "https://elizacloud.ai/api/v1/eliza/agents/shared-1/api";

function pending(
  overrides: Partial<PendingCloudHandoff> = {},
): PendingCloudHandoff {
  return {
    sharedAgentId: "shared-1",
    dedicatedAgentId: "dedicated-1",
    sharedApiBase: SHARED_BASE,
    cloudApiBase: "https://elizacloud.ai",
    startedAt: Date.now(),
    ...overrides,
  };
}

function activeSharedServer(): Record<string, unknown> {
  return {
    kind: "cloud",
    id: "cloud:shared-1",
    apiBase: SHARED_BASE,
    accessToken: "cloud-token",
  };
}

async function settle(): Promise<void> {
  // The resume path awaits the target probe (getCloudCompatAgent) before
  // kicking off the supervisor, then the supervisor awaits its own start(),
  // then success/failure branches dispatch again. Two macrotask hops cover
  // the full chain in these tests.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("resumePendingCloudHandoff", () => {
  beforeEach(() => {
    // Reset call history AND stubbed return values (mockClear keeps the
    // latter, so a per-test mockReturnValue would leak into later tests).
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.startCloudAgentHandoff.mockResolvedValue({
      status: "switched",
      imported: 1,
    });
    mocks.deleteSharedBridgeAgent.mockResolvedValue({ success: true });
    mocks.getCloudAuthToken.mockReturnValue("cloud-token");
    mocks.isDirectCloudSharedAgentBase.mockImplementation((base: string) =>
      base.includes("/api/v1/eliza/agents/"),
    );
    mocks.loadPersistedActiveServer.mockReturnValue(null);
    mocks.runAgentSessionRecovery.mockResolvedValue({
      ok: true,
      redirectUrl: "https://dedicated-1.elizacloud.ai/pair?token=pairing",
      mode: "navigate",
    });
    mocks.getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { id: "dedicated-1", status: "provisioning" },
    });
    mocks.createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: {
        agentId: "dedicated-fresh",
        agentName: "Eliza",
        jobId: "job-fresh",
        status: "provisioning",
        nodeId: null,
        message: "ok",
      },
    });
    window.localStorage.clear();
    __resetResumeForTests();
  });
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("resumes the SAME migration after a reload: same dedicated target, repoint on switch, bridge delete on success", async () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    mocks.startCloudAgentHandoff.mockImplementation(async (opts) => {
      // The supervisor calls onSwitch once the dedicated container is live.
      await (opts as { onSwitch?: (base: string) => Promise<void> }).onSwitch?.(
        "https://dedicated-1.elizacloud.ai",
      );
      return { status: "switched" as const, imported: 1 };
    });

    expect(resumePendingCloudHandoff()).toBe(true);
    await settle();

    expect(mocks.startCloudAgentHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.startCloudAgentHandoff.mock.calls[0][0]).toMatchObject({
      agentId: "shared-1",
      dedicatedAgentId: "dedicated-1",
      sharedApiBase: SHARED_BASE,
      cloudApiBase: "https://elizacloud.ai",
      authToken: "cloud-token",
    });
    expect(mocks.runAgentSessionRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudApiBase: "https://elizacloud.ai",
        agentId: "dedicated-1",
        cloudToken: "cloud-token",
        navigate: expect.any(Function),
      }),
    );
    // Success terminal → the shared bridge row is deleted.
    expect(mocks.deleteSharedBridgeAgent).toHaveBeenCalledWith("shared-1", {
      cloudApiBase: "https://elizacloud.ai",
      authToken: "cloud-token",
    });
  });

  it("native resume consumes the pair redirect in-process and repoints with the exchanged agent key", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
    };
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    mocks.runAgentSessionRecovery.mockImplementationOnce(async (opts) => {
      (
        opts as { onPairedInProcess?: (apiToken: string) => void }
      ).onPairedInProcess?.("agent-api-key");
      return {
        ok: true as const,
        redirectUrl: "https://dedicated-1.elizacloud.ai/pair?token=pairing",
        mode: "in-process" as const,
      };
    });
    mocks.startCloudAgentHandoff.mockImplementation(async (opts) => {
      await (opts as { onSwitch?: (base: string) => Promise<void> }).onSwitch?.(
        "https://dedicated-1.elizacloud.ai",
      );
      return { status: "switched" as const, imported: 1 };
    });

    expect(resumePendingCloudHandoff()).toBe(true);
    await settle();

    expect(mocks.runAgentSessionRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        consumeRedirectInProcess: true,
        onPairedInProcess: expect.any(Function),
      }),
    );
    expect(mocks.silentlyRepointToDedicated).toHaveBeenCalledWith({
      containerBase: "https://dedicated-1.elizacloud.ai",
      dedicatedAgentId: "dedicated-1",
      authToken: "agent-api-key",
    });
  });

  it("does NOT delete the shared bridge when the resumed handoff fails — user stays on shared", async () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    mocks.startCloudAgentHandoff.mockResolvedValue({
      status: "failed",
      imported: 0,
      error: "container never became ready",
    });

    expect(resumePendingCloudHandoff()).toBe(true);
    await settle();

    expect(mocks.deleteSharedBridgeAgent).not.toHaveBeenCalled();
    expect(mocks.runAgentSessionRecovery).not.toHaveBeenCalled();
  });

  it("clears a stale marker when the active server is no longer the pending shared bridge", () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: "cloud:dedicated-1",
      apiBase: "https://dedicated-1.elizacloud.ai",
    });
    mocks.isDirectCloudSharedAgentBase.mockReturnValue(false);

    expect(resumePendingCloudHandoff()).toBe(false);
    expect(loadPendingCloudHandoff()).toBeNull();
    expect(mocks.startCloudAgentHandoff).not.toHaveBeenCalled();
  });

  it("clears a stale marker when the runtime is not cloud anymore", () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue({
      kind: "local",
      id: "local:app-shell",
    });

    expect(resumePendingCloudHandoff()).toBe(false);
    expect(loadPendingCloudHandoff()).toBeNull();
  });

  it("keeps the marker (and allows a later attempt) when cloud auth is not restored yet", () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue({
      ...activeSharedServer(),
      accessToken: undefined,
    });
    mocks.getCloudAuthToken.mockReturnValue(null);

    expect(resumePendingCloudHandoff()).toBe(false);
    expect(loadPendingCloudHandoff()).not.toBeNull();

    // Auth lands → the next call (same session) may resume.
    mocks.getCloudAuthToken.mockReturnValue("cloud-token");
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    expect(resumePendingCloudHandoff()).toBe(true);
  });

  it("attempts at most once per session when a resume was started", async () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    mocks.startCloudAgentHandoff.mockResolvedValue({
      status: "switched",
      imported: 0,
    });

    expect(resumePendingCloudHandoff()).toBe(true);
    expect(resumePendingCloudHandoff()).toBe(false);
    await settle();
    expect(mocks.startCloudAgentHandoff).toHaveBeenCalledTimes(1);
  });

  it("no-ops with no marker", () => {
    expect(resumePendingCloudHandoff()).toBe(false);
    expect(mocks.loadPersistedActiveServer).not.toHaveBeenCalled();
  });

  it("clears the marker and does NOT resume when the dedicated target is gone (control-plane 404)", async () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    // Control-plane lookup reports the target no longer exists.
    mocks.getCloudCompatAgent.mockResolvedValue({
      success: false,
      data: { id: "dedicated-1", status: "deleted" },
    });

    // A resume DECISION is initiated (probe in flight).
    expect(resumePendingCloudHandoff()).toBe(true);

    // Capture the failed phase surfaced by the dead-target path so the tile
    // lights up instead of silently persisting "Setting up…".
    const seenPhases: Array<Record<string, unknown>> = [];
    const onPhase = (event: Event) => {
      seenPhases.push((event as CustomEvent).detail as Record<string, unknown>);
    };
    window.addEventListener("eliza:cloud-handoff-phase", onPhase);

    await settle();

    // Marker is cleared; the supervisor is never called with the dead id.
    expect(loadPendingCloudHandoff()).toBeNull();
    expect(mocks.startCloudAgentHandoff).not.toHaveBeenCalled();
    expect(mocks.getCloudCompatAgent).toHaveBeenCalledWith("dedicated-1");

    // A failed phase for the shared agent id is dispatched so the widget shows
    // its failure surface (existing "Setup paused" + Retry copy).
    const failed = seenPhases.find(
      (d) => d.agentId === "shared-1" && d.phase === "failed",
    );
    expect(failed).toBeTruthy();
    expect(failed?.error).toEqual(expect.stringContaining("no longer"));
    window.removeEventListener("eliza:cloud-handoff-phase", onPhase);
  });

  it("still resumes normally when the target probe is inconclusive (network error, not 404) — never strand on an unprovable assumption", async () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    // A 5xx / network blip is inconclusive; treat as live so the supervisor's
    // own retry/TTL bounds the migration.
    mocks.getCloudCompatAgent.mockRejectedValue(
      Object.assign(new Error("transient"), { status: 503 }),
    );

    expect(resumePendingCloudHandoff()).toBe(true);
    await settle();

    // Resume still fires against the SAME (pending) target — no fresh create.
    expect(mocks.startCloudAgentHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.startCloudAgentHandoff.mock.calls[0][0]).toMatchObject({
      dedicatedAgentId: "dedicated-1",
    });
    expect(mocks.createCloudCompatAgent).not.toHaveBeenCalled();
  });

  it("on Retry after a dead-target clear, mints a FRESH dedicated agent (forceCreate) instead of the dead id", async () => {
    // Use unique ids so no armed retry listener from earlier tests
    // (`runCloudAgentHandoff`'s own retry arming on failed/timed-out) can match
    // and double-fire on our dispatched retry event.
    const uniqueShared = "shared-retry-flow";
    const uniqueDedicated = "dedicated-retry-flow-dead";
    savePendingCloudHandoff(
      pending({
        sharedAgentId: uniqueShared,
        dedicatedAgentId: uniqueDedicated,
      }),
    );
    mocks.loadPersistedActiveServer.mockReturnValue({
      kind: "cloud",
      id: `cloud:${uniqueShared}`,
      apiBase: SHARED_BASE,
      accessToken: "cloud-token",
    });
    mocks.getCloudCompatAgent.mockResolvedValue({
      success: false,
      data: { id: uniqueDedicated, status: "deleted" },
    });

    expect(resumePendingCloudHandoff()).toBe(true);
    await settle();
    expect(loadPendingCloudHandoff()).toBeNull();
    expect(mocks.startCloudAgentHandoff).not.toHaveBeenCalled();

    // Simulate the widget's Retry click: dispatch the retry event for the
    // shared agent id. The armed dead-target listener should mint a FRESH
    // dedicated agent (forceCreate:true) and re-run the handoff against it.
    window.dispatchEvent(
      new CustomEvent("eliza:cloud-handoff-retry", {
        detail: { agentId: uniqueShared },
      }),
    );
    await settle();

    expect(mocks.createCloudCompatAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createCloudCompatAgent.mock.calls[0][0]).toMatchObject({
      forceCreate: true,
    });
    expect(mocks.startCloudAgentHandoff).toHaveBeenCalledTimes(1);
    // Never re-uses the dead id from the cleared marker.
    expect(mocks.startCloudAgentHandoff.mock.calls[0][0]).toMatchObject({
      agentId: uniqueShared,
      dedicatedAgentId: "dedicated-fresh",
    });
    expect(loadPendingCloudHandoff()).toMatchObject({
      sharedAgentId: uniqueShared,
      dedicatedAgentId: "dedicated-fresh",
      sharedApiBase: SHARED_BASE,
      cloudApiBase: "https://elizacloud.ai",
    });
  });
});

describe("pending-handoff-store", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a marker and clears expired ones", () => {
    const marker = pending({ startedAt: Date.now() - 1000 });
    savePendingCloudHandoff(marker);
    expect(loadPendingCloudHandoff()).toEqual(marker);

    // Expired by TTL → cleared on load.
    expect(
      loadPendingCloudHandoff(marker.startedAt + PENDING_HANDOFF_TTL_MS + 1),
    ).toBeNull();
    expect(loadPendingCloudHandoff()).toBeNull();
  });

  it("clears malformed markers instead of resuming from garbage", () => {
    window.localStorage.setItem(
      "eliza:cloud-handoff-pending",
      '{"sharedAgentId": ""}',
    );
    expect(loadPendingCloudHandoff()).toBeNull();
    window.localStorage.setItem("eliza:cloud-handoff-pending", "not json");
    expect(loadPendingCloudHandoff()).toBeNull();
  });
});
