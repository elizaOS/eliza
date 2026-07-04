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
  silentlyRepointToDedicated: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: {
    startCloudAgentHandoff: mocks.startCloudAgentHandoff,
    deleteSharedBridgeAgent: mocks.deleteSharedBridgeAgent,
  },
}));

vi.mock("../../api/client-cloud", () => ({
  getCloudAuthToken: mocks.getCloudAuthToken,
  isDirectCloudSharedAgentBase: mocks.isDirectCloudSharedAgentBase,
}));

vi.mock("../../state", () => ({
  loadPersistedActiveServer: mocks.loadPersistedActiveServer,
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
    window.localStorage.clear();
    __resetResumeForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("resumes the SAME migration after a reload: same dedicated target, repoint on switch, bridge delete on success", async () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    mocks.startCloudAgentHandoff.mockImplementation(async (opts) => {
      // The supervisor calls onSwitch once the dedicated container is live.
      (opts as { onSwitch?: (base: string) => void }).onSwitch?.(
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
    expect(mocks.silentlyRepointToDedicated).toHaveBeenCalledWith({
      containerBase: "https://dedicated-1.elizacloud.ai",
      authToken: "cloud-token",
      dedicatedAgentId: "dedicated-1",
    });
    // Success terminal → the shared bridge row is deleted.
    expect(mocks.deleteSharedBridgeAgent).toHaveBeenCalledWith("shared-1", {
      cloudApiBase: "https://elizacloud.ai",
      authToken: "cloud-token",
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
    expect(mocks.silentlyRepointToDedicated).not.toHaveBeenCalled();
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

  it("attempts at most once per session when a resume was started", () => {
    savePendingCloudHandoff(pending());
    mocks.loadPersistedActiveServer.mockReturnValue(activeSharedServer());
    mocks.startCloudAgentHandoff.mockResolvedValue({
      status: "switched",
      imported: 0,
    });

    expect(resumePendingCloudHandoff()).toBe(true);
    expect(resumePendingCloudHandoff()).toBe(false);
    expect(mocks.startCloudAgentHandoff).toHaveBeenCalledTimes(1);
  });

  it("no-ops with no marker", () => {
    expect(resumePendingCloudHandoff()).toBe(false);
    expect(mocks.loadPersistedActiveServer).not.toHaveBeenCalled();
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
