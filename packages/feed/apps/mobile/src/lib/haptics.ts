/**
 * Haptic feedback utility for native mobile interactions.
 *
 * Wraps Capacitor's Haptics plugin and returns without vibration on web.
 * All functions are fire-and-forget — haptics are non-critical.
 */

import { isNativePlatform } from "./platform";

let hapticsModule: typeof import("@capacitor/haptics") | null = null;

async function getHaptics() {
  if (!isNativePlatform()) return null;
  if (!hapticsModule) {
    hapticsModule = await import("@capacitor/haptics");
  }
  return hapticsModule;
}

/** Light tap — for button presses, toggles, selections. */
export async function tapLight() {
  const haptics = await getHaptics();
  await haptics?.Haptics.impact({ style: haptics.ImpactStyle.Light });
}

/** Medium tap — for successful actions like placing a trade, sending a message. */
export async function tapMedium() {
  const haptics = await getHaptics();
  await haptics?.Haptics.impact({ style: haptics.ImpactStyle.Medium });
}

/** Heavy tap — for significant events like minting an NFT, completing onboarding. */
export async function tapHeavy() {
  const haptics = await getHaptics();
  await haptics?.Haptics.impact({ style: haptics.ImpactStyle.Heavy });
}

/** Success vibration pattern — for confirmed trades, successful transactions. */
export async function notifySuccess() {
  const haptics = await getHaptics();
  await haptics?.Haptics.notification({
    type: haptics.NotificationType.Success,
  });
}

/** Warning vibration — for approaching limits, low balance. */
export async function notifyWarning() {
  const haptics = await getHaptics();
  await haptics?.Haptics.notification({
    type: haptics.NotificationType.Warning,
  });
}

/** Error vibration — for failed transactions, validation errors. */
export async function notifyError() {
  const haptics = await getHaptics();
  await haptics?.Haptics.notification({
    type: haptics.NotificationType.Error,
  });
}

/** Selection tick — for scrolling through lists, picker changes. */
export async function selectionChanged() {
  const haptics = await getHaptics();
  await haptics?.Haptics.selectionChanged();
}
