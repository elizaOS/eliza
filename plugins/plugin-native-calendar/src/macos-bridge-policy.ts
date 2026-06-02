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
