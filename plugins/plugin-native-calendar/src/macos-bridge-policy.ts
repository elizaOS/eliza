/**
 * Candidate-path policy for locating the Electrobun EventKit dylib that
 * macOS desktop hosts — not this Capacitor plugin — load to reach Apple
 * Calendar. Host plugins try candidates in order (env override, packaged,
 * local dev build) and use the first path that exists; the candidate list
 * and expected dylib basename are owned here so host code and packaging
 * stay in sync.
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
    {
      label: "packaged Apple permissions bridge",
      path: `../../../../../../../${APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
    {
      label: "packaged Apple permissions bridge",
      path: `../../../../../../${APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
    {
      label: "local Apple permissions bridge",
      path: `../../../../packages/app-core/platforms/electrobun/src/${APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
  ].filter((candidate) => candidate.path.trim().length > 0);
}
