import { afterEach, describe, expect, it } from "vitest";
import {
  clearTeeBootGateState,
  getTeeBootGateState,
  setTeeBootGateState,
  teeBootGateBlocksSecrets,
} from "./tee-boot-gate-state.ts";

afterEach(() => clearTeeBootGateState());

describe("tee-boot-gate-state", () => {
  it("starts unset and inert", () => {
    expect(getTeeBootGateState()).toBeUndefined();
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });

  it("stores the published gate", () => {
    const gate = { required: true, secretsEnabled: true } as never;
    setTeeBootGateState(gate);
    expect(getTeeBootGateState()).toBe(gate);
  });

  it("blocks secrets only when required and secrets disabled", () => {
    setTeeBootGateState({ required: true, secretsEnabled: false } as never);
    expect(teeBootGateBlocksSecrets()).toBe(true);
  });

  it("does not block when required but secrets enabled", () => {
    setTeeBootGateState({ required: true, secretsEnabled: true } as never);
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });

  it("does not block when not required", () => {
    setTeeBootGateState({ required: false, secretsEnabled: false } as never);
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });

  it("clear resets the singleton", () => {
    setTeeBootGateState({ required: true, secretsEnabled: false } as never);
    clearTeeBootGateState();
    expect(getTeeBootGateState()).toBeUndefined();
    expect(teeBootGateBlocksSecrets()).toBe(false);
  });
});
