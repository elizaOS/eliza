/** Defines the focused renderer modes that must survive in-app path navigation. */

export const FOCUSED_APP_SHELL_MODES = [
  "chat-overlay",
  "tray-popover",
  "voice-selftest",
  "voice-workbench",
  "launcher",
  "kiosk",
] as const;

export type FocusedAppShellMode = (typeof FOCUSED_APP_SHELL_MODES)[number];
export type AppShellMode = FocusedAppShellMode | "full";

const FOCUSED_APP_SHELL_MODE_SET = new Set<string>(FOCUSED_APP_SHELL_MODES);

export function parseFocusedAppShellMode(
  value: string | null | undefined,
): FocusedAppShellMode | null {
  return value && FOCUSED_APP_SHELL_MODE_SET.has(value)
    ? (value as FocusedAppShellMode)
    : null;
}

export function resolveAppShellMode(
  search: string,
  hash: string,
  injectedMode?: string,
): AppShellMode {
  const params = new URLSearchParams(search || hash.split("?")[1] || "");
  return (
    parseFocusedAppShellMode(
      params.get("shellMode") ?? params.get("shell-mode") ?? injectedMode ?? "",
    ) ?? "full"
  );
}
