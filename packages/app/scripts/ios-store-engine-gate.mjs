/**
 * iOS App Store on-device-engine gate (#8861).
 *
 * Decides whether an App Store / TestFlight build will embed the on-device
 * no-JIT Bun engine. Launch IPAs are intentional Cloud-only thin clients;
 * custom store builds may opt into the local runtime and must then embed it.
 *
 * This MIRRORS `shouldIncludeIosFullBunEngine()` in app-core's
 * `run-mobile-build.mjs` (the stager that actually copies the engine in). The
 * preflight gate (`mobile-release-preflight.mjs`, run as `preflight:ios:store`)
 * imports this so release validation and engine staging share one pure source.
 * Cloud-only launch builds intentionally omit the engine; custom builds that
 * opt into local execution fail preflight unless the engine is embedded.
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
  // Launch default OFF: an operator must explicitly opt into local execution.
  const localRuntimeDisabled = /^(0|false|no|off)$/i.test(
    (env.ELIZA_IOS_APP_STORE_LOCAL_RUNTIME ?? "0").trim(),
  );
  const engineForced = /^(1|true|yes|on)$/i.test(
    (env.ELIZA_IOS_FULL_BUN_ENGINE ?? "").trim(),
  );
  // Ships when explicitly forced, or for a custom store build that explicitly
  // enables the optional local runtime.
  const engineWillEmbed =
    engineForced || (storeVariant && !localRuntimeDisabled);
  return { storeVariant, localRuntimeDisabled, engineForced, engineWillEmbed };
}
