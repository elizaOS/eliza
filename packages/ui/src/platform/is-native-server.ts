/**
 * Server-safe native-platform detection.
 *
 * On Capacitor-hosted mobile (iOS / Android), an in-process Node / Bun
 * runtime boots the Eliza server inside the native shell, and Capacitor
 * installs a global `Capacitor` object. On desktop (Electrobun) and plain
 * Node / Bun servers, that global is absent.
 *
 * This module purposely does not import `@capacitor/core` so it is safe to
 * use from server-only code (routes, sidecar lifecycle, config resolution)
 * without pulling DOM/renderer concerns into a Node bundle.
 */

export function isNativeServerPlatform(): boolean {
  const cap = (globalThis as Record<string, unknown>).Capacitor as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return cap?.isNativePlatform?.() === true;
}
