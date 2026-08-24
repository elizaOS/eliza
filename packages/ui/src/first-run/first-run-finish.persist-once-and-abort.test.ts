/** Verifies the exactly-once POST funnel, cooperative cancellation, and the hybrid OAuth gate of the headless first-run finish use case. */
// @vitest-environment jsdom

/**
 * Coverage for three behaviors of `first-run-finish.ts` the sibling suites do
 * not touch: the module-scoped exactly-once `persistFirstRun` funnel (shared
 * in-flight POST, sequential idempotency, guard reset, retry-after-failure),
 * the #19255 cooperative-cancellation `throwIfAborted` checkpoints, and the
 * local + cloud-inference hybrid gate that returns `needs-cloud-login` before
 * any local start or persist. Cloud completion/handoff coverage lives in
 * `first-run-finish.reused-shared-handoff.test.ts`,
 * `first-run-finish.firstload-chain.test.ts`, and
 * `first-run-finish.force-fresh.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import {
  addAgentProfile,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../state";
import { autoDownloadRecommendedLocalModelInBackground } from "./auto-download-recommended";
import type { FirstRunProfileDraft } from "./first-run";
import {
  bindCloudAgent,
  type FirstRunFinishDraft,
  type FirstRunFinishPorts,
  listOrAutoProvisionCloudAgent,
  resetFirstRunPersistGuard,
  runFirstRunFinish,
} from "./first-run-finish";

vi.mock("../api", () => ({
  client: {
    submitFirstRun: vi.fn(async () => {}),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
    getBaseUrl: vi.fn(() => ""),
    getAuthStatus: vi.fn(async () => ({ ok: true })),
    getRestAuthToken: vi.fn(() => null),
    selectOrProvisionCloudAgent: vi.fn(),
    getCloudStatus: vi.fn(async () => ({ connected: false })),
  },
}));

vi.mock("../platform/init", () => ({
  isAndroid: false,
  isIOS: false,
  isNative: false,
  isDesktopPlatform: () => false,
}));

vi.mock("./auto-download-recommended", () => ({
  autoDownloadRecommendedLocalModelInBackground: vi.fn(),
}));

vi.mock("./runtime-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-target")>()),
  resolveFirstRunLocalAgentApiBase: () => "",
}));

vi.mock("../state", () => ({
  addAgentProfile: vi.fn(() => ({ id: "profile-1" })),
  createPersistedActiveServer: vi.fn((v) => v),
  loadPersistedActiveServer: vi.fn(() => null),
  removeAgentProfile: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  savePersistedFirstRunComplete: vi.fn(),
}));

vi.mock("./mobile-runtime-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mobile-runtime-mode")>()),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
}));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => ({
    cloudApiBase: "https://staging.elizacloud.ai",
    preferSharedCloudTier: false,
  }),
}));

const SHARED_AGENT_ID = "23766030-c096-4a14-932a-a4e43c562432";
const SHARED_AGENT_BASE = `https://staging.elizacloud.ai/api/v1/eliza/agents/${SHARED_AGENT_ID}`;

const submitFirstRunMock = vi.mocked(client.submitFirstRun);
const selectOrProvisionMock = vi.mocked(client.selectOrProvisionCloudAgent);
const savePersistedActiveServerMock = vi.mocked(savePersistedActiveServer);
const savePersistedFirstRunCompleteMock = vi.mocked(
  savePersistedFirstRunComplete,
);
const addAgentProfileMock = vi.mocked(addAgentProfile);

function finishDraft(
  overrides: Partial<FirstRunProfileDraft> = {},
): FirstRunFinishDraft {
  return {
    agentName: "Eliza",
    runtime: "local",
    localInference: "all-local",
    remoteApiBase: "",
    remoteToken: "",
    ...overrides,
  } as FirstRunFinishDraft;
}

function cloudDraft(): FirstRunProfileDraft {
  return {
    agentName: "Eliza",
    runtime: "cloud",
    localInference: "cloud-inference",
    remoteApiBase: "",
    remoteToken: "",
  };
}

function ports(
  overrides: Partial<FirstRunFinishPorts> = {},
  signal?: AbortSignal,
): FirstRunFinishPorts {
  return {
    uiLanguage: "en",
    elizaCloudConnected: true,
    handleInteractiveCloudLogin: vi.fn(async () => {}),
    setRuntimeState: vi.fn(),
    setTab: vi.fn(),
    completeFirstRun: vi.fn(),
    onStatus: vi.fn(),
    ...(signal ? { signal } : {}),
    ...overrides,
  };
}

function stubSelection(): void {
  selectOrProvisionMock.mockResolvedValue({
    agentId: SHARED_AGENT_ID,
    agentName: "Eliza",
    apiBase: SHARED_AGENT_BASE,
    bridgeUrl: `https://${SHARED_AGENT_ID}.elizacloud.ai`,
    requiresAgentPairing: false,
    created: false,
  });
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

async function settledRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFirstRunPersistGuard();
  window.localStorage.clear();
});

describe("exactly-once POST funnel (persistFirstRun)", () => {
  it("concurrent finishes share ONE in-flight POST and both land done", async () => {
    const outcomes = await Promise.all([
      runFirstRunFinish(finishDraft(), ports()),
      runFirstRunFinish(finishDraft(), ports()),
    ]);
    expect(submitFirstRunMock).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toEqual({ kind: "done" });
    expect(outcomes[1]).toEqual({ kind: "done" });
  });

  it("a completed finish posts exactly once across sequential re-entry", async () => {
    const first = await runFirstRunFinish(finishDraft(), ports());
    const second = await runFirstRunFinish(finishDraft(), ports());
    expect(first.kind).toBe("done");
    expect(second.kind).toBe("done");
    expect(submitFirstRunMock).toHaveBeenCalledTimes(1);
  });

  it("resetFirstRunPersistGuard re-arms the funnel for a fresh onboarding", async () => {
    await runFirstRunFinish(finishDraft(), ports());
    expect(submitFirstRunMock).toHaveBeenCalledTimes(1);
    resetFirstRunPersistGuard();
    await runFirstRunFinish(finishDraft(), ports());
    expect(submitFirstRunMock).toHaveBeenCalledTimes(2);
  });

  it("a failed POST does not latch the funnel — the next finish retries", async () => {
    submitFirstRunMock.mockRejectedValueOnce(new Error("persist boom"));
    const first = await runFirstRunFinish(finishDraft(), ports());
    expect(first).toEqual({ kind: "error", message: "persist boom" });
    const second = await runFirstRunFinish(finishDraft(), ports());
    expect(second).toEqual({ kind: "done" });
    expect(submitFirstRunMock).toHaveBeenCalledTimes(2);
  });
});

describe("#19255 cooperative cancellation", () => {
  it("an aborted signal stops listOrAutoProvisionCloudAgent before any login or state change", async () => {
    const p = ports({}, abortedSignal());
    const error = await settledRejection(
      listOrAutoProvisionCloudAgent(cloudDraft(), p),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(p.handleInteractiveCloudLogin).not.toHaveBeenCalled();
    expect(p.setRuntimeState).not.toHaveBeenCalled();
  });

  it("an aborted signal stops bindCloudAgent before provisioning", async () => {
    const p = ports({}, abortedSignal());
    const error = await settledRejection(
      bindCloudAgent(cloudDraft(), "steward-jwt", {}, p),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(selectOrProvisionMock).not.toHaveBeenCalled();
  });

  it("aborting between provisioning and durable persistence binds and saves nothing", async () => {
    const controller = new AbortController();
    stubSelection();
    selectOrProvisionMock.mockImplementationOnce(async () => {
      controller.abort();
      return {
        agentId: SHARED_AGENT_ID,
        agentName: "Eliza",
        apiBase: SHARED_AGENT_BASE,
        bridgeUrl: `https://${SHARED_AGENT_ID}.elizacloud.ai`,
        requiresAgentPairing: false,
        created: true,
      };
    });
    const p = ports({}, controller.signal);
    const error = await settledRejection(
      bindCloudAgent(cloudDraft(), "steward-jwt", {}, p),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(savePersistedActiveServerMock).not.toHaveBeenCalled();
    expect(addAgentProfileMock).not.toHaveBeenCalled();
    expect(savePersistedFirstRunCompleteMock).not.toHaveBeenCalled();
    expect(client.setBaseUrl).not.toHaveBeenCalled();
    expect(p.completeFirstRun).not.toHaveBeenCalled();
  });
});

describe("local + cloud-inference hybrid OAuth gate", () => {
  it("demands cloud login before starting or persisting anything", async () => {
    const p = ports({ elizaCloudConnected: false });
    const outcome = await runFirstRunFinish(
      finishDraft({ runtime: "local", localInference: "cloud-inference" }),
      p,
    );
    expect(outcome).toEqual({ kind: "needs-cloud-login" });
    expect(p.setRuntimeState).toHaveBeenCalledWith(
      "firstRunRuntimeTarget",
      "elizacloud-hybrid",
    );
    expect(p.setRuntimeState).toHaveBeenCalledWith(
      "firstRunProvider",
      "elizacloud",
    );
    expect(p.handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
    expect(p.completeFirstRun).not.toHaveBeenCalled();
    expect(submitFirstRunMock).not.toHaveBeenCalled();
    expect(client.getAuthStatus).not.toHaveBeenCalled();
    expect(
      autoDownloadRecommendedLocalModelInBackground,
    ).not.toHaveBeenCalled();
  });
});
