export function isCapacitorNativeRuntime(): boolean {
  try {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | {
          isNativePlatform?: () => boolean;
        }
      | undefined;
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    // error-policy:J4 an unanswerable platform probe reads as "not native",
    // preserving the browser's WebSocket path.
    return false;
  }
}
