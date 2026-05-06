import { describe, expect, it, vi } from "vitest";
import type { AgentStatus, OnboardingOptions } from "../api/client";
import {
  type CompleteResetLocalStateDeps,
  completeResetLocalStateAfterServerWipe,
} from "./complete-reset-local-state-after-wipe";

const okOptions = {
  styles: [{ id: "a", name: "A", avatarIndex: 0 }],
} as unknown as OnboardingOptions;

function buildSpyDeps(overrides: Partial<CompleteResetLocalStateDeps> = {}): {
  deps: CompleteResetLocalStateDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const trace =
    (label: string) =>
    (..._args: unknown[]): void => {
      calls.push(label);
    };
  const traceAsync =
    <T>(label: string, value: T) =>
    async (): Promise<T> => {
      calls.push(label);
      return value;
    };
  const deps: CompleteResetLocalStateDeps = {
    setAgentStatus: trace("setAgentStatus"),
    resetClientConnection: trace("resetClientConnection"),
    clearPersistedActiveServer: trace("clearPersistedActiveServer"),
    clearPersistedAvatarIndex: trace("clearPersistedAvatarIndex"),
    setClientBaseUrl: trace("setClientBaseUrl"),
    setClientToken: trace("setClientToken"),
    clearElizaCloudSessionUi: trace("clearElizaCloudSessionUi"),
    markOnboardingReset: trace("markOnboardingReset"),
    resetAvatarSelection: trace("resetAvatarSelection"),
    clearConversationLists: trace("clearConversationLists"),
    fetchOnboardingOptions: traceAsync("fetchOnboardingOptions", okOptions),
    setOnboardingOptions: trace("setOnboardingOptions"),
    logResetDebug: () => {},
    logResetWarn: () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("completeResetLocalStateAfterServerWipe", () => {
  it("fires deps in the documented atomicity order", async () => {
    const { deps, calls } = buildSpyDeps();
    await completeResetLocalStateAfterServerWipe(null, deps);
    expect(calls).toEqual([
      "setAgentStatus",
      "resetClientConnection",
      "clearPersistedActiveServer",
      "clearPersistedAvatarIndex",
      "setClientBaseUrl",
      "setClientToken",
      "clearElizaCloudSessionUi",
      "markOnboardingReset",
      "resetAvatarSelection",
      "clearConversationLists",
      "fetchOnboardingOptions",
      "setOnboardingOptions",
    ]);
  });

  it("token-clear (clearElizaCloudSessionUi) fires immediately before markOnboardingReset", async () => {
    const { deps, calls } = buildSpyDeps();
    await completeResetLocalStateAfterServerWipe(null, deps);
    const tokenIdx = calls.indexOf("clearElizaCloudSessionUi");
    const onboardingIdx = calls.indexOf("markOnboardingReset");
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(onboardingIdx).toBe(tokenIdx + 1);
  });

  it("forwards the post-reset agent status to setAgentStatus", async () => {
    const setAgentStatus = vi.fn();
    const { deps } = buildSpyDeps({ setAgentStatus });
    const status = { state: "stopped" } as unknown as AgentStatus;
    await completeResetLocalStateAfterServerWipe(status, deps);
    expect(setAgentStatus).toHaveBeenCalledWith(status);
  });

  it("absorbs fetchOnboardingOptions failure without rolling back the wipe", async () => {
    const setOnboardingOptions = vi.fn();
    const logResetWarn = vi.fn();
    const { deps, calls } = buildSpyDeps({
      fetchOnboardingOptions: async () => {
        throw new Error("network down");
      },
      setOnboardingOptions,
      logResetWarn,
    });
    await expect(
      completeResetLocalStateAfterServerWipe(null, deps),
    ).resolves.toBeUndefined();
    expect(setOnboardingOptions).not.toHaveBeenCalled();
    expect(logResetWarn).toHaveBeenCalledWith(
      "resetLocalState: getOnboardingOptions failed after reset",
      expect.any(Error),
    );
    expect(calls).toContain("clearConversationLists");
    expect(calls).not.toContain("setOnboardingOptions");
  });

  it("propagates a failure from any non-fetch callback (no silent swallow)", async () => {
    const { deps } = buildSpyDeps({
      markOnboardingReset: () => {
        throw new Error("setter exploded");
      },
    });
    await expect(
      completeResetLocalStateAfterServerWipe(null, deps),
    ).rejects.toThrow("setter exploded");
  });
});
