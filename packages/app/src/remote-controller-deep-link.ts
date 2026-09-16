/**
 * Decides whether a remote-controller claim may enter the platform pairing
 * flow. iOS is admitted only when the compiled native key/crypto owner is
 * registered; other Capacitor shells fail closed.
 */

/** Allows claim delivery only to the two shells that own controller keys. */
export function isRemoteControllerPairingRuntimeAllowed(input: {
  isElectrobun: boolean;
  navigatorPlatform: string;
  nativePlatform: string;
  native: boolean;
  nativePluginAvailable: boolean;
}): boolean {
  const isLinuxDesktop =
    input.isElectrobun &&
    input.navigatorPlatform.toLowerCase().includes("linux");
  const isNativeIOS =
    input.native &&
    input.nativePlatform === "ios" &&
    input.nativePluginAvailable;
  return isLinuxDesktop || isNativeIOS;
}
