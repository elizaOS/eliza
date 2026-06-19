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

function readShellModeArg(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith(SHELL_MODE_ARG_PREFIX)) {
      return arg.slice(SHELL_MODE_ARG_PREFIX.length);
    }
  }
  return null;
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
  if (env.ELIZAOS_SHELL_MODE === "kiosk") return true;
  return readShellModeArg(argv) === "kiosk";
}

/**
 * Append `?shellMode=kiosk` to the renderer URL so the React app renders its
 * `KioskShell`. Preserves any existing query string and hash routing.
 */
export function appendKioskShellModeParam(rendererUrl: string): string {
  try {
    const url = new URL(rendererUrl);
    url.searchParams.set("shellMode", "kiosk");
    return url.href;
  } catch {
    const separator = rendererUrl.includes("?") ? "&" : "?";
    return `${rendererUrl}${separator}shellMode=kiosk`;
  }
}
