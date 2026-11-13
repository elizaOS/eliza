/**
 * Candidate-path policy for locating the macOS EventKit dylib that agent
 * hosts — not this Capacitor plugin — load to reach Apple Calendar. The
 * dylib is named by `ELIZA_NATIVE_PERMISSIONS_DYLIB` or found in a source
 * checkout under `packages/app/native/macos/`. Host plugins try candidates in
 * order and use the first path that exists.
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
      label: "local Apple permissions bridge",
      path: `../../../packages/app/native/macos/${APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
    {
      label: "nested local Apple permissions bridge",
      path: `../../../../packages/app/native/macos/${APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
  ].filter((candidate) => candidate.path.trim().length > 0);
}
