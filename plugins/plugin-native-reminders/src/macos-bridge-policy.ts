/**
 * Candidate-path policy for locating the macOS EventKit dylib
 * (`libMacWindowEffects.dylib`) that backs Apple Reminders access — the same
 * dylib the desktop permissions/EventKit bridge uses. Lives here rather than
 * in `plugin-personal-assistant`/LifeOps so the resolution logic stays a
 * pure, reusable, testable unit; callers resolve `ELIZA_NATIVE_PERMISSIONS_DYLIB`
 * themselves and pass it in, so this package never reads env directly.
 * Candidates are ordered env-override, then packaged (two relative-depth
 * variants for different install layouts), then local dev build; empty paths
 * are filtered out.
 */

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
      label: "packaged Apple permissions bridge",
      path: `../../../../../../../${APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
    {
      label: "packaged Apple permissions bridge",
      path: `../../../../../../${APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
    {
      label: "local Apple permissions bridge",
      path: `../../../../packages/app-core/platforms/electrobun/src/${APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME}`,
    },
  ].filter((candidate) => candidate.path.trim().length > 0);
}
