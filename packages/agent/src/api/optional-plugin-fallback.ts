/**
 * Provides an observable fallback for optional-plugin route imports. Packages
 * deliberately absent from mobile builds fall through to the normal 404,
 * while broken transitive imports and missing handler exports warn instead of
 * being misclassified as benign package absence (#12089, #12661).
 */

import { logger } from "@elizaos/core";
import { isModuleNotFoundError } from "../utils/module-resolution-error.ts";

export { isModuleNotFoundError } from "../utils/module-resolution-error.ts";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the no-op fallback API returned when an optional plugin is unavailable.
 *
 * Handlers still resolve to `() => false` so route-dispatch
 * (`if (await handleX(...)) return;`) falls through to the normal 404 instead of
 * 500ing — but the FIRST access of each distinct handler name emits an
 * observable warning tagged as drift when `observeAccess` is true. That way a
 * present-but-renamed export (mode 2) is surfaced, while the benign
 * module-absent case (mode 1, `observeAccess=false`) stays silent.
 */
export function createOptionalPluginFallback<T>(
  key: string,
  observeAccess: boolean,
): T {
  const warned = new Set<string>();
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        // CRITICAL: this fallback is returned from `async`/Promise catch paths
        // (getOptionalPluginApi, getWalletApi). When a promise resolves with an
        // object, the runtime reads its `then` to test for thenable assimilation.
        // If we returned a callable for `then`, the value would be treated as a
        // thenable and the awaiting promise would NEVER settle — every affected
        // optional-plugin route would hang instead of falling through to 404.
        // Return undefined for promise-assimilation keys and any symbol key
        // (Symbol.toPrimitive, Symbol.iterator, …) so the object stays an inert,
        // non-thenable no-op API.
        if (
          prop === "then" ||
          prop === "catch" ||
          prop === "finally" ||
          typeof prop === "symbol"
        ) {
          return undefined;
        }
        if (observeAccess && !warned.has(prop)) {
          warned.add(prop);
          logger.warn(
            `[eliza-api] optional plugin '${key}' loaded but handler '${prop}' ` +
              `is absent (export missing/renamed?); route dispatch will 404. ` +
              `This is a drift signal, not an expected mobile-bundle exclusion.`,
          );
        }
        return () => false;
      },
    },
  ) as T;
}

/**
 * Classify an optional-plugin import rejection and return the appropriate no-op
 * fallback. Module-not-found → quiet fallthrough (expected bundle exclusion).
 * Any OTHER error → the plugin should have loaded but threw: warn (observable
 * drift) and hand back a fallback whose handler access is also observable.
 */
export function resolveOptionalPluginImportFailure<T>(
  key: string,
  err: unknown,
  specifier?: string,
): T {
  // Prefer the package specifier for the absence check so a broken transitive
  // import inside a PRESENT plugin isn't mistaken for a benign bundle exclusion.
  if (isModuleNotFoundError(err, specifier ?? key)) {
    logger.debug(
      `[eliza-api] optional plugin '${key}' not in this bundle: ${describeError(err)}`,
    );
    return createOptionalPluginFallback<T>(key, false);
  }
  // Present-but-broken: a plugin that resolved but failed to initialize (syntax
  // error, failed top-level init, missing transitive dep). Under the old code
  // this was a silent debug line and every route 404'd invisibly. Surface it.
  logger.warn(
    `[eliza-api] optional plugin '${key}' failed to load (present but errored): ` +
      `${describeError(err)}. Routes for this plugin will 404 until fixed.`,
  );
  return createOptionalPluginFallback<T>(key, true);
}
