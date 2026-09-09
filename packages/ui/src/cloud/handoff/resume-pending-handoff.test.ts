/**
 * Exercises boot recovery with real marker storage/events and deterministic
 * client boundaries. A persisted target or host flag is never current consent.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLastCloudHandoffPhaseDetailForTests,
  dispatchCloudHandoffRetry,
  getLastCloudHandoffPhaseDetail,
} from "../../events";
import {
  loadPendingCloudHandoff,
  PENDING_HANDOFF_TTL_MS,
  savePendingCloudHandoff,
} from "./pending-handoff-store";
import {
  __resetResumeForTests,
  resumePendingCloudHandoff,
} from "./resume-pending-handoff";

const mocks = vi.hoisted(() => ({
  startCloudAgentHandoff: vi.fn(async () => ({
    status: "switched",
    imported: 0,
  })),
  createCloudCompatAgent: vi.fn(async () => ({
    success: true,
    data: { agentId: "fresh-target" },
  })),
  deleteSharedBridgeAgent: vi.fn(async () => ({ success: true })),
  getCloudCompatAgent: vi.fn(async () => ({
    success: true,
    data: { id: "dedicated-1", status: "running" },
  })),
  loadPersistedActiveServer:
    vi.fn<
      () => {
        kind: string;
        id: string;
        apiBase?: string;
        accessToken?: string;
      } | null
    >(),
  automaticUpgrade: true,
}));
vi.mock("../../api", () => ({ client: mocks }));
vi.mock("../../api/client-cloud", () => ({
  getCloudAuthToken: () => "test-session",
  isDirectCloudSharedAgentBase: (base: string) =>
    base.includes("/api/v1/eliza/agents/"),
}));
vi.mock("../../config/boot-config-store", () => ({
  getBootConfig: () => ({
    autoUpgradeSharedToDedicated: mocks.automaticUpgrade,
  }),
}));
vi.mock("../../state/persistence", () => ({
  loadPersistedActiveServer: mocks.loadPersistedActiveServer,
}));
vi.mock("./silent-repoint", () => ({ silentlyRepointToDedicated: vi.fn() }));

const SHARED_BASE = "https://api.eliza.app/api/v1/eliza/agents/shared-1";
const marker = () => ({
  sharedAgentId: "shared-1",
  dedicatedAgentId: "dedicated-1",
  sharedApiBase: SHARED_BASE,
  cloudApiBase: "https://api.eliza.app",
  startedAt: Date.now(),
});
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function expectNoRuntimeWork() {
  expect(mocks.getCloudCompatAgent).not.toHaveBeenCalled();
  expect(mocks.startCloudAgentHandoff).not.toHaveBeenCalled();
  expect(mocks.createCloudCompatAgent).not.toHaveBeenCalled();
  expect(mocks.deleteSharedBridgeAgent).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.automaticUpgrade = true;
  mocks.getCloudCompatAgent.mockResolvedValue({
    success: true,
    data: { id: "dedicated-1", status: "running" },
  });
  mocks.loadPersistedActiveServer.mockReturnValue({
    kind: "cloud",
    id: "cloud:shared-1",
    apiBase: SHARED_BASE,
  });
  localStorage.clear();
  __resetResumeForTests();
  __resetLastCloudHandoffPhaseDetailForTests();
});
afterEach(() => {
  __resetResumeForTests();
  localStorage.clear();
});

describe("pending handoff requires renewed consent", () => {
  it.each([true, false])(
    "offers review without using host auto-upgrade=%s as consent",
    async (enabled) => {
      mocks.automaticUpgrade = enabled;
      const pending = marker();
      savePendingCloudHandoff(pending);
      expect(resumePendingCloudHandoff()).toBe(true);
      await settle();
      expectNoRuntimeWork();
      expect(loadPendingCloudHandoff()).toEqual(pending);
      expect(getLastCloudHandoffPhaseDetail()).toMatchObject({
        agentId: "shared-1",
        phase: "confirmation-required",
      });
    },
  );
  it("never recreates a dead target when a stale Retry event arrives", async () => {
    mocks.getCloudCompatAgent.mockResolvedValue({
      success: false,
      data: { id: "dedicated-1", status: "deleted" },
    });
    const pending = marker();
    savePendingCloudHandoff(pending);
    resumePendingCloudHandoff();
    await settle();
    dispatchCloudHandoffRetry({ agentId: "shared-1" });
    await settle();
    expectNoRuntimeWork();
    expect(loadPendingCloudHandoff()).toEqual(pending);
  });
  it("does not treat a reload or repeated recovery call as approval", async () => {
    savePendingCloudHandoff(marker());
    expect(resumePendingCloudHandoff()).toBe(true);
    expect(resumePendingCloudHandoff()).toBe(false);
    __resetResumeForTests();
    expect(resumePendingCloudHandoff()).toBe(true);
    await settle();
    expectNoRuntimeWork();
  });
  it("can surface a marker that appears after an initial empty boot check", () => {
    expect(resumePendingCloudHandoff()).toBe(false);
    savePendingCloudHandoff(marker());
    expect(resumePendingCloudHandoff()).toBe(true);
    expectNoRuntimeWork();
  });
  it.each([
    { kind: "local", id: "local:app-shell" },
    { kind: "cloud", id: "cloud:another-agent", apiBase: SHARED_BASE },
    {
      kind: "cloud",
      id: "cloud:dedicated-1",
      apiBase: "https://dedicated-1.cloud.eliza.app",
    },
  ])(
    "clears only the stale local marker after target change: $id",
    (active) => {
      savePendingCloudHandoff(marker());
      mocks.loadPersistedActiveServer.mockReturnValue(active);
      expect(resumePendingCloudHandoff()).toBe(false);
      expect(loadPendingCloudHandoff()).toBeNull();
      expectNoRuntimeWork();
    },
  );
  it("no-ops without a marker", () => {
    expect(resumePendingCloudHandoff()).toBe(false);
    expect(mocks.loadPersistedActiveServer).not.toHaveBeenCalled();
    expectNoRuntimeWork();
  });
});

describe("pending-handoff-store", () => {
  it("round-trips a marker and clears expired ones", () => {
    const pending = marker();
    savePendingCloudHandoff(pending);
    expect(loadPendingCloudHandoff()).toEqual(pending);
    expect(
      loadPendingCloudHandoff(pending.startedAt + PENDING_HANDOFF_TTL_MS + 1),
    ).toBeNull();
    expect(loadPendingCloudHandoff()).toBeNull();
  });
  it("clears malformed markers instead of resuming from garbage", () => {
    localStorage.setItem(
      "eliza:cloud-handoff-pending",
      '{"sharedAgentId": ""}',
    );
    expect(loadPendingCloudHandoff()).toBeNull();
    localStorage.setItem("eliza:cloud-handoff-pending", "not json");
    expect(loadPendingCloudHandoff()).toBeNull();
  });
});
