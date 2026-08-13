/**
 * Stateless client/public surface of `@elizaos/core` (#18056 / #18704).
 *
 * The app Vite config aliases bare `@elizaos/core` to the prebuilt browser
 * blob. Callers that must stay off that blob import this subpath instead.
 *
 * This file may export types, constants, and pure functions only. Do not
 * re-export `ElizaError`, connector-source registration, or any other
 * identity-bearing / module-level mutable registry. Those need a design
 * where the root barrel and this subpath share one module instance.
 */

export { resolveAliasedEnvValue } from "./boot-env.ts";
export { isTruthyEnvValue } from "./env-utils.ts";
export {
	isElizaSettingsDebugEnabled,
	sanitizeForSettingsDebug,
	settingsDebugCloudSummary,
} from "./settings-debug.ts";
export { formatError } from "./utils/format-error.ts";
