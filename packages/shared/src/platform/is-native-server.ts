/**
 * Server-safe native-platform detection.
 *
 * On Capacitor-hosted mobile, an in-process runtime boots inside the native
 * shell and Capacitor installs a global object. Plain Node/Bun and desktop
 * server processes do not.
 */
export function isNativeServerPlatform(): boolean {
  const cap = (globalThis as Record<string, unknown>).Capacitor as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return cap?.isNativePlatform?.() === true;
}
