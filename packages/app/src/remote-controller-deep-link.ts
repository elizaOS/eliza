import { Capacitor } from "@capacitor/core";

/** Allow controller-claim delivery only to enrolled Linux desktop or native iOS shells. */
export function isRemoteControllerPairingRuntimeAllowed(input?: {
  isElectrobun?: boolean;
  navigatorPlatform?: string;
  nativePlatform?: string;
  native?: boolean;
}): boolean {
  const isLinuxDesktop =
    (input?.isElectrobun ?? false) &&
    (input?.navigatorPlatform ?? "").toLowerCase().includes("linux");
  const isNativeIOS =
    (input?.native ?? Capacitor.isNativePlatform()) &&
    (input?.nativePlatform ?? Capacitor.getPlatform()) === "ios";
  return isLinuxDesktop || isNativeIOS;
}
