// @vitest-environment jsdom

/**
 * Regression: a returning user with a healthy running shared/dedicated cloud
 * agent must NOT be bounced back into onboarding after a new build deploys /
 * the PWA relaunches.
 *
 * Root cause (bug(cloud-onboarding): onboarding re-enters for returning user
 * with running agent after new build deploy):
 *
 * The durable `elizaos:first-run:force-fresh` flag is a ONE-SHOT "re-run
 * onboarding on next boot" directive (armed by `?reset` or an in-session agent
 * reset). The restore phase consumes it by calling
 * `savePersistedFirstRunComplete(false)` and clearing the active server, so a
 * boot with the flag set legitimately re-onboards. The flag is meant to be
 * CLEARED the moment onboarding completes so the boot AFTER completion lands in
 * chat.
 *
 * For the app-shell (local / dedicated container) runtime the clear happens
 * inside `client.submitFirstRun` (the reset client patch clears force-fresh on
 * the POST). But a SHARED / direct cloud agent base does NOT own
 * `/api/first-run`, so `bindCloudAgent` SKIPS `persistFirstRun` — and therefore
 * never reached the `submitFirstRun` clear. A user who onboarded a shared cloud
 * agent while force-fresh was armed completed onboarding with the flag STILL
 * set, so the next cold boot / PWA relaunch re-ran the force-fresh consume and
 * bounced them back into "Setting up your agent…" against a perfectly healthy
 * running agent.
 *
 * The fix clears force-fresh on the cloud completion path too, so "completion
 * clears force-fresh" holds for EVERY runtime. This test drives the real
 * `bindCloudAgent` against a shared-agent base with force-fresh armed and
 * asserts the durable flag is cleared by completion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearForceFreshFirstRun,
  enableForceFreshFirstRun,
  isForceFreshFirstRunEnabled,
} from "../platform/first-run-reset";
import type { FirstRunProfileDraft } from "./first-run";
import type { FirstRunFinishPorts } from "./first-run-finish";
import { bindCloudAgent } from "./first-run-finish";

const SHARED_AGENT_BASE =
  "https://staging.elizacloud.ai/api/v1/eliza/agents/cad3c071";

const clientMock = vi.hoisted(() => ({
  selectOrProvisionCloudAgent: vi.fn(),
  submitFirstRun: vi.fn(async () => {}),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
  getBaseUrl: vi.fn(() => ""),
}));

vi.mock("../api", () => ({ client: clientMock }));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => ({ cloudApiBase: "https://staging.elizacloud.ai" }),
}));

vi.mock("../state", () => ({
  addAgentProfile: vi.fn(() => ({ id: "profile-1" })),
  createPersistedActiveServer: vi.fn((v) => ({ label: "Eliza Cloud", ...v })),
  loadPersistedActiveServer: vi.fn(() => null),
  removeAgentProfile: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  savePersistedFirstRunComplete: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  clientMock.selectOrProvisionCloudAgent.mockResolvedValue({
    agentId: "cad3c071",
    apiBase: SHARED_AGENT_BASE,
    requiresAgentPairing: false,
    created: false,
  });
});

afterEach(() => {
  clearForceFreshFirstRun();
  window.localStorage.clear();
});

describe("bindCloudAgent clears the durable force-fresh flag on completion", () => {
  it("a shared-agent completion clears force-fresh so the next boot lands in chat, NOT re-onboarding", async () => {
    // Arrange: force-fresh armed (e.g. a prior ?reset / in-session agent reset)
    enableForceFreshFirstRun();
    expect(isForceFreshFirstRunEnabled()).toBe(true);

    // Act: complete onboarding against a SHARED cloud agent base (skips the
    // /api/first-run POST — the historically-uncovered clear path).
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());

    // Assert: onboarding completed AND the durable directive is cleared, so a
    // subsequent cold boot / PWA relaunch does NOT re-run the force-fresh
    // consume that re-onboards a returning user.
    expect(outcome.kind).toBe("done");
    expect(isForceFreshFirstRunEnabled()).toBe(false);
    // The shared-agent path must NOT POST /api/first-run.
    expect(clientMock.submitFirstRun).not.toHaveBeenCalled();
    expect(clientMock.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preferStewardAgentAdapter: false }),
    );
  });

  it("is a no-op-safe clear when force-fresh was never armed (idempotent)", async () => {
    expect(isForceFreshFirstRunEnabled()).toBe(false);
    const outcome = await bindCloudAgent(draft(), "steward-token", {}, ports());
    expect(outcome.kind).toBe("done");
    expect(isForceFreshFirstRunEnabled()).toBe(false);
  });
});
