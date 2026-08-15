/**
 * Resolves the capability flags shared by the Node, browser, and Workerd core
 * compositions. Platform entry points choose the implementation they can host;
 * this module keeps the flag semantics identical across those compositions.
 */

/** Capability composition accepted by the platform-specific basic plugin. */
export interface CapabilityConfig {
	disableBasic?: boolean;
	enableExtended?: boolean;
	advancedCapabilities?: boolean;
	skipCharacterProvider?: boolean;
	enableAutonomy?: boolean;
	enableTrust?: boolean;
	enableSecretsManager?: boolean;
	enablePluginManager?: boolean;
}

/** Constructor-level overrides; omitted values defer to character settings. */
export interface ExplicitCapabilityOptions {
	disableBasic?: boolean;
	enableExtended?: boolean;
	advancedCapabilities?: boolean;
	skipCharacterProvider?: boolean;
	enableAutonomy?: boolean;
	enableTrust?: boolean;
	enableSecretsManager?: boolean;
	enablePluginManager?: boolean;
}

/** Character settings that can enable or disable runtime capabilities. */
export interface CapabilitySettingFlags {
	DISABLE_BASIC_CAPABILITIES?: boolean | string;
	ENABLE_EXTENDED_CAPABILITIES?: boolean | string;
	ADVANCED_CAPABILITIES?: boolean | string;
	ENABLE_AUTONOMY?: boolean | string;
	ENABLE_TRUST?: boolean | string;
	ENABLE_SECRETS_MANAGER?: boolean | string;
	ENABLE_PLUGIN_MANAGER?: boolean | string;
}

const isSettingEnabled = (value: boolean | string | undefined): boolean =>
	value === true || value === "true";

/** Resolves explicit options over character settings into one configuration. */
export function resolveCapabilityConfig(
	options: ExplicitCapabilityOptions,
	settings: CapabilitySettingFlags | undefined,
): CapabilityConfig {
	return {
		disableBasic:
			options.disableBasic ??
			isSettingEnabled(settings?.DISABLE_BASIC_CAPABILITIES),
		enableExtended:
			options.enableExtended ??
			options.advancedCapabilities ??
			(isSettingEnabled(settings?.ENABLE_EXTENDED_CAPABILITIES) ||
				isSettingEnabled(settings?.ADVANCED_CAPABILITIES)),
		skipCharacterProvider: options.skipCharacterProvider ?? false,
		enableAutonomy:
			options.enableAutonomy ?? isSettingEnabled(settings?.ENABLE_AUTONOMY),
		enableTrust:
			options.enableTrust ?? isSettingEnabled(settings?.ENABLE_TRUST),
		enableSecretsManager:
			options.enableSecretsManager ??
			isSettingEnabled(settings?.ENABLE_SECRETS_MANAGER),
		enablePluginManager:
			options.enablePluginManager ??
			isSettingEnabled(settings?.ENABLE_PLUGIN_MANAGER),
	};
}
