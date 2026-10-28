import {
  type ClientTurnObservation,
  isClientTimeZone,
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
 * Native device hosts (the Clock host's chat bridge) share this slot with a
 * screen-less device context: `{sensitive: false, revision, timeZone}`,
 * optionally with the Eliza-owned alarm snapshot alongside. It names no view
 * and no selection, so it is projected to a non-private observation with an
 * empty view, no selection and only a time zone the platform admits. Every
 * view or selection fence stays closed; device time-zone readers keep the
 * device clock they had before the typed contract.
 */
function screenlessDeviceObservation(
  context: unknown,
): ClientTurnObservation | undefined {
  if (!context || typeof context !== "object" || Array.isArray(context))
    return undefined;
  if (
    Object.hasOwn(context, "view") ||
    Object.hasOwn(context, "selectedObject") ||
    Reflect.get(context, "sensitive") !== false
  )
    return undefined;
  const revision = Reflect.get(context, "revision");
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return undefined;
  const timeZone = Reflect.get(context, "timeZone");
  return Object.freeze({
    view: "",
    revision,
    sensitive: false,
    ...(isClientTimeZone(timeZone) ? { timeZone } : {}),
  });
}

/**
 * The current turn's client observation read through the shared contract.
 * Returns undefined when the message carries no observation, the screen-less
 * device projection for a native host's device context, and the private
 * stand-in when it carries anything else the contract rejects.
 */
export function turnObservation(
  metadata: unknown,
): ClientTurnObservation | undefined {
  const context = deviceContext(metadata);
  if (context === undefined) return undefined;
  return (
    readClientTurnObservation(metadata) ??
    screenlessDeviceObservation(context) ??
    UNREADABLE_TURN_OBSERVATION
  );
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
  return (
    readClientTurnObservation(metadata) ??
    screenlessDeviceObservation(context) ??
    UNREADABLE_TURN_OBSERVATION
  );
}
