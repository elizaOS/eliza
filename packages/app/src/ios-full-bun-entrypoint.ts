/**
 * Runs the iOS full-Bun smoke before the interactive app boot spends work on
 * route modules or React. The composition root supplies each platform bridge,
 * keeping this ordering decision deterministic and directly testable.
 */

export interface IosFullBunEntrypointDependencies {
  isIOS: boolean;
  fullBunAvailable: boolean;
  initializeStorageBridge: () => Promise<unknown>;
  initializeCapacitorBridge: () => unknown;
  installNativeRequestBridge: () => unknown;
  installFetchBridge: () => unknown;
  runSmoke: (options: { fullBunAvailable: boolean }) => Promise<boolean>;
}

/** Returns true only when the smoke took ownership of the iOS WebView. */
export async function runIosFullBunEntrypoint(
  dependencies: IosFullBunEntrypointDependencies,
): Promise<boolean> {
  if (!dependencies.isIOS) return false;
  if (!dependencies.fullBunAvailable) {
    await dependencies.runSmoke({ fullBunAvailable: false });
    return false;
  }
  await dependencies.initializeStorageBridge();
  dependencies.initializeCapacitorBridge();
  dependencies.installNativeRequestBridge();
  dependencies.installFetchBridge();
  return dependencies.runSmoke({ fullBunAvailable: true });
}
