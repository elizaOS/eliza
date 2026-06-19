/**
 * In-process holder for the one-time TEE boot-gate decision (plan §4.1).
 *
 * The boot path evaluates the gate exactly once (see
 * `runtime/eliza.ts` → `runTeeBootGate`). Modules that guard real secret
 * paths — agent-wallet key reveal/bridge, remote plugin sync — cannot reach
 * that closure-local decision, so the boot path publishes it here and those
 * modules consult `teeBootGateBlocksSecrets()`.
 *
 * Inert by default: the singleton starts unset. Non-TEE / local-only boots
 * either never set a gate or set one whose `required === false`, so
 * `teeBootGateBlocksSecrets()` returns false and gated paths behave exactly as
 * they did before TEE gating existed.
 */

import type { TeeBootGate } from "./tee-boot-gate.ts";

let currentGate: TeeBootGate | undefined;

/** Publish the one-time boot-gate decision for cross-module consumption. */
export function setTeeBootGateState(gate: TeeBootGate): void {
  currentGate = gate;
}

/** The published boot-gate decision, or undefined when none has been set. */
export function getTeeBootGateState(): TeeBootGate | undefined {
  return currentGate;
}

/** Reset the singleton. Tests only — production sets the gate exactly once. */
export function clearTeeBootGateState(): void {
  currentGate = undefined;
}

/**
 * True ONLY when a gate is set, the policy requires trusted TEE evidence, and
 * that evidence is not trusted (secrets disabled). When no gate is set, or the
 * policy is not required, or secrets are enabled, this returns false — so the
 * default (non-TEE) case is fully inert.
 */
export function teeBootGateBlocksSecrets(): boolean {
  return (
    currentGate !== undefined &&
    currentGate.required === true &&
    currentGate.secretsEnabled === false
  );
}
