import type { JsonValue } from "./primitives";

/**
 * Runtime settings provided as key/value strings.
 */
export interface RuntimeSettings {
	values?: Record<string, string>;
	[key: string]: JsonValue | undefined;
}

/**
 * Definition metadata for a setting (without value).
 */
export interface SettingDefinition {
	name: string;
	description: string;
	usageDescription: string;
	required: boolean;
	public?: boolean;
	secret?: boolean;
	dependsOn: string[];
}

/**
 * Concrete setting value with runtime-only callbacks.
 */
export interface Setting {
	name: string;
	description: string;
	usageDescription: string;
	required: boolean;
	value: string | boolean | null;
	public?: boolean;
	secret?: boolean;
	validation?: (value: string | boolean | null) => boolean;
	dependsOn: string[];
	onSetAction?: (value: string | boolean | null) => string;
	visibleIf?: (settings: Record<string, Setting>) => boolean;
}

/**
 * World settings configuration map.
 */
export interface WorldSettings {
	settings?: Record<string, Setting>;
	[key: string]: Setting | Record<string, Setting> | undefined;
}

/**
 * Onboarding configuration with setting definitions.
 */
export interface OnboardingConfig {
	settings: Record<string, SettingDefinition>;
}
