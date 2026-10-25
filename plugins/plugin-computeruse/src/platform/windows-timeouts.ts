/**
 * Env-overridable timeout floor for PowerShell / WinRT spawns on Windows.
 *
 * On Defender-heavy Windows hosts, real-time AV scans every fresh
 * `powershell.exe` process image, adding a measured ~10-16s tax to each cold
 * spawn (see #9581). The warm PowerShell host (`ps-host.ts`) amortizes this for
 * the capture/clipboard hot path, but two classes of spawn still pay the cold
 * tax and can false-fail with `ETIMEDOUT` while the capability itself is fine:
 *   1. the one-shot fallback spawns taken whenever the warm host is
 *      unavailable/disabled/errored, and
 *   2. the synchronous window-enumeration / window-op paths in
 *      `windows-list.ts`, which can't use the async warm host.
 *
 * `ELIZA_COMPUTERUSE_PS_TIMEOUT_MS` lets an operator on an extreme host raise
 * EVERY PowerShell spawn budget at once without a code change. It is applied as
 * a FLOOR: each call site keeps its own (relative) default and the env value
 * only ever RAISES it, never lowers it — so it can never tighten a budget into
 * a regression. Unset / non-numeric / non-positive → defaults unchanged.
 *
 * Mirrors the existing `ELIZA_WAYLAND_PORTAL_TIMEOUT_MS` escape hatch in
 * `wayland-portal.ts`.
 */

/** Env var operators set to raise the PowerShell spawn-timeout floor (ms). */
export const PS_SPAWN_TIMEOUT_ENV = "ELIZA_COMPUTERUSE_PS_TIMEOUT_MS";

/**
 * Resolve a PowerShell spawn timeout: the call site's `baseMs` raised to the
 * `ELIZA_COMPUTERUSE_PS_TIMEOUT_MS` floor when that env var is a valid positive
 * integer. Returns `baseMs` unchanged otherwise.
 */
export function psSpawnTimeoutMs(baseMs: number): number {
  const raw = process.env[PS_SPAWN_TIMEOUT_ENV];
  if (!raw) return baseMs;
  const floor = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(floor) || floor <= 0) return baseMs;
  return Math.max(baseMs, floor);
}
