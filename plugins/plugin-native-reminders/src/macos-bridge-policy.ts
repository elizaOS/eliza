export interface AppleRemindersMacosBridgeCandidate {
  label: string;
  path: string;
}

export const APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME =
  "libMacWindowEffects.dylib";

export function appleRemindersMacosBridgeCandidates(args?: {
  envDylibPath?: string | null;
}): AppleRemindersMacosBridgeCandidate[] {
  return [
    {
      label: "ELIZA_NATIVE_PERMISSIONS_DYLIB",
      path: args?.envDylibPath ?? "",
    },
    {
      label: "local Apple permissions bridge",
      path: `../../../../packages/app/native/macos/${APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
  ].filter((candidate) => candidate.path.trim().length > 0);
}
