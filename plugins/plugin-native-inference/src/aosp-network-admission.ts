import { ElizaError } from "@elizaos/core";
import { probeBionicNetworkPolicy } from "./bionic-network-policy.js";
import {
  evaluateNetworkPolicy,
  type NetworkPolicyPreferences,
  type RawNetworkState,
} from "./model-catalog/network-policy.js";
import { readVoiceNetworkPreferences } from "./voice-network-preferences.js";

export interface AospNetworkAdmissionOptions {
  probe?: () => Promise<RawNetworkState>;
  now?: () => number;
  preferences?: NetworkPolicyPreferences;
}

async function readAndroidNetwork(): Promise<RawNetworkState> {
  const socket = process.env.ELIZA_BIONIC_INFERENCE_SOCK?.trim();
  if (!socket)
    throw new ElizaError("Android network state is unavailable", {
      code: "NETWORK_POLICY_UNAVAILABLE",
    });
  return probeBionicNetworkPolicy(socket);
}

/** Each transfer owns its admission clock; no unmetered result survives between downloads. */
export function createAospNetworkAdmissionCheck(
  estimatedBytes: number,
  options: AospNetworkAdmissionOptions = {},
): (force?: boolean) => Promise<void> {
  const probe = options.probe ?? readAndroidNetwork;
  const now = options.now ?? (() => performance.now());
  let checkedAt: number | undefined;
  return async (force = false) => {
    if (!force && checkedAt !== undefined && now() - checkedAt < 1000) return;
    const decision = evaluateNetworkPolicy(
      await probe(),
      options.preferences ?? (await readVoiceNetworkPreferences()),
      estimatedBytes,
    );
    if (!decision.allow)
      throw new ElizaError(
        "Automatic model download requires an allowed network",
        {
          code: "NETWORK_POLICY_REFUSED",
          context: { reason: decision.reason, networkClass: decision.class },
        },
      );
    checkedAt = now();
  };
}
