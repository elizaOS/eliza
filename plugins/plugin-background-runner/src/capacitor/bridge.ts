/**
 * Thin shim around `@capacitor-community/background-runner`.
 *
 * Why a shim and not a direct import:
 *  - The Capacitor plugin is an OPTIONAL peer. Server / desktop / web builds
 *    must not fail to load this plugin just because the native module isn't
 *    installed.
 *  - The Capacitor module is ESM-only and resolves a Capacitor `WebPlugin`
 *    that registers itself against `window`. Probing for it via dynamic
 *    `import()` keeps the dependency truly optional.
 *
 * The runtime contract for `@capacitor-community/background-runner@2.x`:
 *  - `BackgroundRunner.dispatchEvent({ label, event, details })` — fires a
 *    JS handler registered by the host app under
 *    `runners/<label>.js`. The native side wakes the JS context, runs the
 *    handler, then suspends.
 *  - Native registration of the iOS BGTaskScheduler identifier and Android
 *    WorkManager job lives in the Capacitor app's `Info.plist`,
 *    `AndroidManifest.xml`, and `capacitor.config.ts`. See INSTALL.md.
 *
 * This shim only exposes a presence check and a typed dispatch function. The
 * actual native scheduling is configured at app build time, not from JS.
 */

export interface BackgroundRunnerLike {
  dispatchEvent: (options: {
    label: string;
    event: string;
    details: Record<string, unknown>;
  }) => Promise<unknown>;
}

export interface CapacitorEnvironment {
  isCapacitor: boolean;
  runner: BackgroundRunnerLike | null;
}

/**
 * Dynamic resolution. Wrapped in try/catch ONLY at the import boundary because
 * a missing optional peer is the expected case and we must distinguish it
 * from an installed-but-broken module.
 */
export async function resolveCapacitorEnvironment(): Promise<CapacitorEnvironment> {
  let isCapacitor = false;
  try {
    const core = (await tryImport('@capacitor/core')) as {
      Capacitor?: { isNativePlatform?: () => boolean };
    } | null;
    isCapacitor = core?.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return { isCapacitor: false, runner: null };
  }

  if (!isCapacitor) {
    return { isCapacitor: false, runner: null };
  }

  const mod = (await tryImport('@capacitor-community/background-runner')) as {
    BackgroundRunner?: BackgroundRunnerLike;
  } | null;
  if (mod?.BackgroundRunner == null) {
    return { isCapacitor: true, runner: null };
  }
  return { isCapacitor: true, runner: mod.BackgroundRunner };
}

/**
 * Dynamic import behind an indirection so TypeScript treats the specifier as
 * a runtime value. Optional peers may not be installed; a missing module
 * resolves to `null` rather than throwing through to the caller.
 */
async function tryImport(specifier: string): Promise<unknown> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as unknown;
  } catch {
    return null;
  }
}
