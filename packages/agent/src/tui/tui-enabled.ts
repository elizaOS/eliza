/**
 * Whether the interactive terminal TUI should run. Kept in its own module
 * (no `@elizaos/tui` import) so callers can decide *before* importing the
 * TUI surface — server-only / cloud containers have no TTY and may ship
 * without `@elizaos/tui` bundled, where importing it would crash boot.
 */
export function isTerminalTuiEnabled(): boolean {
  const value = process.env.ELIZA_TERMINAL_TUI?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off") return false;
  if (value === "1" || value === "true" || value === "on") return true;
  if (process.env.CI === "true" || process.env.NODE_ENV === "test") {
    return false;
  }
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
