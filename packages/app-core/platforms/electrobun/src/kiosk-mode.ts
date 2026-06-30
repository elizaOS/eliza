/**
 * Kiosk shell mode for the Linux OS appliance build.
 *
 * When the OS launches the Electrobun bundle as the entire GUI (single
 * fullscreen window under a single-window compositor such as `cage`), the app
 * runs in "kiosk" mode: one frameless, non-closable, fullscreen toplevel that
 * IS the view manager. Agent-spawned dynamic views render as in-window
 * surfaces on the kiosk canvas rather than as separate OS toplevels.
 *
 * Activated by `ELIZAOS_SHELL_MODE=kiosk` or a `--shell-mode=kiosk` argv flag.
 */

const SHELL_MODE_ARG_PREFIX = "--shell-mode=";
const RENDERER_SHELL_MODES = new Set([
  "chat-overlay",
  "tray-popover",
  "voice-selftest",
  "voice-workbench",
  "launcher",
  "kiosk",
  "full",
]);

function readShellModeArg(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith(SHELL_MODE_ARG_PREFIX)) {
      return arg.slice(SHELL_MODE_ARG_PREFIX.length);
    }
  }
  return null;
}

/**
 * Shell mode requested for the main renderer. `kiosk` has special native window
 * presentation, but the renderer URL parameter is shared by every focused
 * shell surface (`voice-selftest`, `voice-workbench`, tray popover, etc.).
 */
export function readRendererShellMode(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): string | null {
  const raw = env.ELIZAOS_SHELL_MODE ?? readShellModeArg(argv);
  if (!raw) return null;
  const normalized = raw.trim();
  return RENDERER_SHELL_MODES.has(normalized) ? normalized : null;
}

/**
 * Resolve whether the process was launched in kiosk shell mode. Reads the
 * `ELIZAOS_SHELL_MODE` env var first, then falls back to the `--shell-mode=`
 * argv flag so both the OS init service and manual launches agree.
 */
export function isKioskShellMode(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  return readRendererShellMode(env, argv) === "kiosk";
}

/**
 * Append `?shellMode=<mode>` to the renderer URL so the React app renders the
 * requested focused shell. Preserves any existing query string and hash routing.
 */
export function appendShellModeParam(
  rendererUrl: string,
  shellMode: string,
): string {
  try {
    const url = new URL(rendererUrl);
    url.searchParams.set("shellMode", shellMode);
    return url.href;
  } catch {
    const separator = rendererUrl.includes("?") ? "&" : "?";
    return `${rendererUrl}${separator}shellMode=${encodeURIComponent(shellMode)}`;
  }
}

/**
 * Append `?shellMode=kiosk` to the renderer URL so the React app renders its
 * `KioskShell`. Preserves any existing query string and hash routing.
 */
export function appendKioskShellModeParam(rendererUrl: string): string {
  return appendShellModeParam(rendererUrl, "kiosk");
}
