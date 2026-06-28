// Coverage for the pure first-run setup-step navigation helpers (onboarding UX).
// These drive next/previous/revert navigation, the cloud fast-track gate, and
// the cloud-only step filtering — all pure decision logic with no co-located
// test. The step order is read from getSetupStepOrder() so the assertions stay
// correct if the SETUP_STEPS list changes.

import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/init", () => ({ canRunLocal: vi.fn(() => false) }));

import { canRunLocal } from "../platform/init";
import {
  canRevertSetupTo,
  getFlaminaTopicForSetupStep,
  getSetupNavMetas,
  getSetupStepIndex,
  getSetupStepOrder,
  resolveSetupNextStep,
  resolveSetupPreviousStep,
  shouldSkipConnectionStepsForCloudProvisionedContainer,
  shouldUseCloudSetupFastTrack,
} from "./setup-steps";

const order = getSetupStepOrder();

describe("setup-step navigation", () => {
  it("exposes a non-empty ordered step list with consistent indices", () => {
    expect(order.length).toBeGreaterThan(1);
    expect(getSetupStepIndex(order[2])).toBe(2);
    expect(getSetupStepIndex("not-a-step" as never)).toBe(-1);
  });

  it("walks next/previous and clamps at the ends", () => {
    expect(resolveSetupNextStep(order[0])).toBe(order[1]);
    expect(resolveSetupPreviousStep(order[1])).toBe(order[0]);
    expect(resolveSetupPreviousStep(order[0])).toBeNull();
    expect(resolveSetupNextStep(order[order.length - 1])).toBeNull();
  });

  it("allows reverting only to an earlier step", () => {
    expect(canRevertSetupTo({ current: order[2], target: order[0] })).toBe(
      true,
    );
    expect(canRevertSetupTo({ current: order[0], target: order[2] })).toBe(
      false,
    );
    expect(canRevertSetupTo({ current: order[1], target: order[1] })).toBe(
      false,
    );
  });
});

describe("getSetupNavMetas", () => {
  it("drops the connection step when cloud-only", () => {
    const metas = getSetupNavMetas(order[0], true);
    expect(metas.some((m) => m.id === "connection")).toBe(false);
  });

  it("keeps the connection step when local is unavailable is false and not cloud-only", () => {
    vi.mocked(canRunLocal).mockReturnValue(false);
    expect(
      getSetupNavMetas(order[0], false).some((m) => m.id === "connection"),
    ).toBe(true);
    // When local CAN run, the connection step is dropped even without cloud-only.
    vi.mocked(canRunLocal).mockReturnValue(true);
    expect(
      getSetupNavMetas(order[0], false).some((m) => m.id === "connection"),
    ).toBe(false);
    vi.mocked(canRunLocal).mockReturnValue(false);
  });
});

describe("cloud setup gating", () => {
  it("skips the connection step only for a cloud-provisioned container on that step", () => {
    expect(
      shouldSkipConnectionStepsForCloudProvisionedContainer({
        currentStep: "connection" as never,
        cloudProvisionedContainer: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipConnectionStepsForCloudProvisionedContainer({
        currentStep: "model" as never,
        cloudProvisionedContainer: true,
      }),
    ).toBe(false);
  });

  it("fast-tracks a provisioned container or a cloud connection (unless local+non-cloud provider)", () => {
    expect(
      shouldUseCloudSetupFastTrack({
        cloudProvisionedContainer: true,
        elizaCloudConnected: false,
        firstRunRunMode: "",
        firstRunProvider: "",
      }),
    ).toBe(true);
    expect(
      shouldUseCloudSetupFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: true,
        firstRunRunMode: "cloud",
        firstRunProvider: "elizacloud",
      }),
    ).toBe(true);
    // Cloud connected, but the user explicitly chose local + a non-cloud provider.
    expect(
      shouldUseCloudSetupFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: true,
        firstRunRunMode: "local",
        firstRunProvider: "openai",
      }),
    ).toBe(false);
    // Local mode but the elizacloud provider does not exclude the fast track.
    expect(
      shouldUseCloudSetupFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: true,
        firstRunRunMode: "local",
        firstRunProvider: "elizacloud",
      }),
    ).toBe(true);
    expect(
      shouldUseCloudSetupFastTrack({
        cloudProvisionedContainer: false,
        elizaCloudConnected: false,
        firstRunRunMode: "",
        firstRunProvider: "",
      }),
    ).toBe(false);
  });
});

describe("getFlaminaTopicForSetupStep", () => {
  it("maps model→provider, capabilities→features, else null", () => {
    expect(getFlaminaTopicForSetupStep("model" as never)).toBe("provider");
    expect(getFlaminaTopicForSetupStep("capabilities" as never)).toBe(
      "features",
    );
    expect(getFlaminaTopicForSetupStep("connection" as never)).toBeNull();
  });
});
