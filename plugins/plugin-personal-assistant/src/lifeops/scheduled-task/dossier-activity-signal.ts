/**
 * Classifies normalized owner-client events that can admit a daily dossier.
 * Passive device snapshots are not activity: native Android unlocks require the
 * exact user-present broadcast, while foreground events retain their own path.
 * The caller authenticates the reporting owner; this is not OS attestation.
 */
import { type LifeOpsActivitySignal } from "@elizaos/core/contracts/personal-assistant";
export function classifyDossierActivitySignal(
  signal: Pick<
    LifeOpsActivitySignal,
    "source" | "platform" | "state" | "idleState" | "metadata"
  >,
): "foreground" | "unlock" | "other" {
  if (
    signal.state === "active" &&
    (signal.source === "app_lifecycle" || signal.source === "page_visibility")
  )
    return "foreground";
  if (
    signal.source === "desktop_power" &&
    signal.state === "active" &&
    signal.idleState === "active" &&
    signal.metadata.windowFocused === true &&
    signal.metadata.documentVisibility === "visible"
  )
    return "foreground";
  if (
    signal.source === "mobile_device" &&
    signal.platform === "android" &&
    signal.metadata.reason === "broadcast:android.intent.action.USER_PRESENT" &&
    signal.metadata.isDeviceLocked === false &&
    signal.metadata.isInteractive === true &&
    signal.state !== "locked" &&
    signal.state !== "sleeping" &&
    signal.idleState !== "locked"
  )
    return "unlock";
  return "other";
}
