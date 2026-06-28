/**
 * iOS App Store on-device-engine gate (#8861).
 *
 * Decides whether an App Store / TestFlight build will embed the on-device
 * no-JIT Bun engine — i.e. whether the shipped IPA can actually start the local
 * agent, or is a thin client that hard-fails "start local agent".
 *
 * This MIRRORS `shouldIncludeIosFullBunEngine()` in app-core's
 * `run-mobile-build.mjs` (the stager that actually copies the engine in). The
 * preflight gate (`mobile-release-preflight.mjs`, run as `preflight:ios:store`,
 * which FAILS the build when the engine would be missing) imports this so the
 * fail-the-build decision and the stage-the-engine decision share one pure
 * source and can't silently drift apart and re-ship a thin client — the exact
 * regression #8861 exists to prevent.
 *
 * Pure `env -> decision`, no side effects, so the gate is unit-testable.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ storeVariant: boolean, localRuntimeDisabled: boolean, engineForced: boolean, engineWillEmbed: boolean }}
 */
export function evaluateIosStoreEngineGate(env = process.env) {
  const storeVariant =
    env.ELIZA_BUILD_VARIANT?.toLowerCase() === "store" ||
    env.ELIZA_RELEASE_AUTHORITY === "apple-app-store";
  // Default ON: an operator must explicitly opt into a cloud-only thin client.
  const localRuntimeDisabled = /^(0|false|no|off)$/i.test(
    (env.ELIZA_IOS_APP_STORE_LOCAL_RUNTIME ?? "1").trim(),
  );
  const engineForced = /^(1|true|yes|on)$/i.test(
    (env.ELIZA_IOS_FULL_BUN_ENGINE ?? "").trim(),
  );
  // Ships when explicitly forced, or for a store build with the local runtime
  // left enabled (the default).
  const engineWillEmbed =
    engineForced || (storeVariant && !localRuntimeDisabled);
  return { storeVariant, localRuntimeDisabled, engineForced, engineWillEmbed };
}
