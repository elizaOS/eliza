/**
 * Candidate-path policy for locating the macOS EventKit dylib that agent
 * hosts — not this Capacitor plugin — load to reach Apple Calendar. The
 * dylib is named by `ELIZA_NATIVE_PERMISSIONS_DYLIB`.
 */
export interface AppleCalendarMacosBridgeCandidate {
  label: string;
  path: string;
}

export const APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME =
  "libMacWindowEffects.dylib";

export function appleCalendarMacosBridgeCandidates(args?: {
  envDylibPath?: string | null;
}): AppleCalendarMacosBridgeCandidate[] {
  return [
    {
      label: "ELIZA_NATIVE_PERMISSIONS_DYLIB",
      path: args?.envDylibPath ?? "",
    },
  ].filter((candidate) => candidate.path.trim().length > 0);
}
