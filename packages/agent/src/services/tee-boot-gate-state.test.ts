import { afterEach, describe, expect, it } from "vitest";
import type { TeeBootGate } from "./tee-boot-gate.ts";
import {
  clearTeeBootGateState,
  getTeeBootGateState,
  setTeeBootGateState,
  teeBootGateBlocksSecrets,
} from "./tee-boot-gate-state.ts";

const blockingGate: TeeBootGate = {
  policy: undefined,
  teeConfigured: true,
  required: true,
  productionProfile: false,
  secretsEnabled: false,
};

const trustedRequiredGate: TeeBootGate = {
  policy: undefined,
  teeConfigured: true,
  required: true,
  productionProfile: false,
  secretsEnabled: true,
};

const localOnlyGate: TeeBootGate = {
  policy: undefined,
  teeConfigured: false,
  required: false,
  productionProfile: false,
  secretsEnabled: true,
};

describe("tee-boot-gate-state", () => {
  afterEach(() => {
    clearTeeBootGateState();
  });

  it("is inert by default (no gate set)", () => {
    expect(getTeeBootGateState()).toBeUndefined();
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });

  it("set/get round-trips the published decision", () => {
    setTeeBootGateState(blockingGate);
    expect(getTeeBootGateState()).toBe(blockingGate);
  });

  it("clear resets to the inert default", () => {
    setTeeBootGateState(blockingGate);
    clearTeeBootGateState();
    expect(getTeeBootGateState()).toBeUndefined();
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });

  it("blocks only when required AND secrets disabled", () => {
    setTeeBootGateState(blockingGate);
    expect(teeBootGateBlocksSecrets()).toBe(true);
  });

  it("does not block when TEE is required but evidence is trusted", () => {
    setTeeBootGateState(trustedRequiredGate);
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });

  it("does not block for a local-only (not required) gate", () => {
    setTeeBootGateState(localOnlyGate);
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });

  it("does not block when secrets are disabled but policy is not required", () => {
    setTeeBootGateState({
      policy: undefined,
      teeConfigured: true,
      required: false,
      productionProfile: false,
      secretsEnabled: false,
    });
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });
});
