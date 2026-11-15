/** Plugin-package auto-enable contracts declared by `elizaos.plugin.autoEnableModule`. */

/**
 * Runtime context passed to a plugin package's lightweight auto-enable check.
 *
 * This is plugin author API surface and intentionally belongs in core so plugin
 * packages do not depend on app/shared packages just to type an optional
 * manifest predicate.
 */
export interface PluginAutoEnableContext {
	/** Process env. Read-only — predicates must not mutate. */
	env: NodeJS.ProcessEnv;
	/** The user's resolved Eliza config. Read-only. */
	config: Record<string, unknown>;
	/** True when the runtime is hosted inside a Capacitor native shell. */
	isNativePlatform: boolean;
}

/**
 * Shape of the small check module declared by package.json
 * `elizaos.plugin.autoEnableModule`.
 */
export interface PluginAutoEnableModule {
	shouldEnable: (ctx: PluginAutoEnableContext) => boolean | Promise<boolean>;
	shouldForce?: (ctx: PluginAutoEnableContext) => boolean;
}
