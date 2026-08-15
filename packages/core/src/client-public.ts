/**
 * Duplicate-safe client/public surface of `@elizaos/core` (#18056 / #18704).
 *
 * The app Vite config aliases bare `@elizaos/core` to the prebuilt browser
 * blob. Callers that must stay off that blob import this subpath instead.
 *
 * Core entrypoints are bundled separately, so values exported here must remain
 * coherent when both the root barrel and this subpath are loaded. Functions
 * may read cross-bundle state only through the existing `Symbol.for` ambient
 * slots. Do not export classes, private mutable registries, or other values
 * whose correctness depends on one module instance.
 */

export { resolveAliasedEnvValue } from "./boot-env.ts";
export { isTruthyEnvValue } from "./env-utils.ts";
export {
	isElizaSettingsDebugEnabled,
	sanitizeForSettingsDebug,
	settingsDebugCloudSummary,
} from "./settings-debug.ts";
export { formatError } from "./utils/format-error.ts";
