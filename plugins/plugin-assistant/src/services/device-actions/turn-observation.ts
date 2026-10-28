import {
  type ClientTurnObservation,
  readClientTurnObservation,
} from "@elizaos/contracts/client-turn-observation";
import { DeviceActionError } from "./contract.ts";

/**
 * Stand-in for a `clientDevice.context` that is present but does not satisfy
 * the shared current-turn observation contract. It reads as a private screen
 * with no view, time zone or selection, so every device-action reader that
 * fences on `sensitive`, `view` or `selectedObject` stays closed instead of
 * trusting fields the contract did not admit.
 */
export const UNREADABLE_TURN_OBSERVATION: ClientTurnObservation = Object.freeze(
  { view: "", revision: 0, sensitive: true },
);

function deviceContext(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return undefined;
  const device = Reflect.get(metadata, "clientDevice");
  if (!device || typeof device !== "object" || Array.isArray(device))
    return undefined;
  return Reflect.get(device, "context");
}

/**
 * The current turn's client observation read through the shared contract.
 * Returns undefined when the message carries no observation, and the private
 * stand-in when it carries one the contract rejects.
 */
export function turnObservation(
  metadata: unknown,
): ClientTurnObservation | undefined {
  const context = deviceContext(metadata);
  if (context === undefined) return undefined;
  return readClientTurnObservation(metadata) ?? UNREADABLE_TURN_OBSERVATION;
}

/**
 * Like {@link turnObservation} for readers that require an observation object:
 * a missing `clientDevice.context` is a malformed device turn and throws.
 */
export function requireTurnObservation(
  metadata: unknown,
): ClientTurnObservation {
  const context = deviceContext(metadata);
  if (!context || typeof context !== "object" || Array.isArray(context))
    throw new DeviceActionError("Expected an object");
  return readClientTurnObservation(metadata) ?? UNREADABLE_TURN_OBSERVATION;
}
