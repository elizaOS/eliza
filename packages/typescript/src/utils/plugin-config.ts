import type { z } from "zod";
import type { IAgentRuntime } from "../types/runtime.js";
import { parseBooleanValue } from "./boolean.js";
import { getEnv } from "./environment.js";

export type ConfigSettingValue = string | boolean | number | undefined;

export type SettingSourceOptions = {
	runtime?: Pick<IAgentRuntime, "getSetting">;
	envFallback?: boolean;
};

export type LoadPluginConfigOptions<TOutput> = {
	schema: z.ZodType<TOutput>;
	raw: Record<string, unknown>;
	scope: string;
	onError?: "throw" | "return-undefined";
};

function hasValue(
	value: string | boolean | number | null | undefined,
): value is string | boolean | number {
	return value !== undefined && value !== null;
}

/**
 * Resolve a single setting from runtime-first sources.
 *
 * V1 intentionally only handles runtime settings plus optional environment
 * fallback. Alias keys, derived values, and character-setting merges stay
 * outside this helper so common config loading stays predictable.
 *
 * Why: the most repeated plugin config boilerplate was not the schema itself,
 * but the "where do I read this value from?" logic. Keeping that precedence in
 * one helper makes debugging easier and prevents plugins from silently drifting.
 */
export function resolveSettingRaw(
	key: string,
	options: SettingSourceOptions = {},
): ConfigSettingValue {
	const runtimeValue = options.runtime?.getSetting(key);
	if (hasValue(runtimeValue)) {
		return runtimeValue;
	}

	if (options.envFallback === true) {
		return getEnv(key);
	}

	return undefined;
}

/**
 * Collect a raw config object without applying any plugin-specific policy.
 *
 * Why: many callers still need to inject or override a few fields before
 * validation. Keeping collection separate from schema parsing avoids a helper
 * that tries to be too smart for every plugin shape.
 */
export function collectSettings(
	keys: readonly string[],
	options: SettingSourceOptions = {},
): Record<string, ConfigSettingValue> {
	return Object.fromEntries(
		keys.map((key) => [key, resolveSettingRaw(key, options)]),
	);
}

export function getStringSetting(
	key: string,
	options: SettingSourceOptions = {},
	defaultValue?: string,
): string | undefined {
	const value = resolveSettingRaw(key, options);
	if (value === undefined) {
		return defaultValue;
	}

	return typeof value === "string" ? value : String(value);
}

export function getBooleanSetting(
	key: string,
	options: SettingSourceOptions = {},
	defaultValue?: boolean,
): boolean | undefined {
	const value = resolveSettingRaw(key, options);
	if (value === undefined) {
		return defaultValue;
	}

	if (typeof value === "number") {
		if (value === 1) {
			return true;
		}
		if (value === 0) {
			return false;
		}
		return defaultValue;
	}

	return parseBooleanValue(value) ?? defaultValue;
}

export function getNumberSetting(
	key: string,
	options: SettingSourceOptions = {},
	defaultValue?: number,
): number | undefined {
	const value = resolveSettingRaw(key, options);
	if (value === undefined) {
		return defaultValue;
	}

	if (typeof value === "number") {
		return Number.isNaN(value) ? defaultValue : value;
	}

	if (typeof value !== "string") {
		return defaultValue;
	}

	const normalized = value.trim();
	if (!normalized) {
		return defaultValue;
	}

	const parsed = Number(normalized);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}

export function getEnumSetting<TValue extends string>(
	key: string,
	allowedValues: readonly TValue[],
	options: SettingSourceOptions = {},
	defaultValue?: TValue,
): TValue | undefined {
	const value = getStringSetting(key, options);
	if (value === undefined) {
		return defaultValue;
	}

	return allowedValues.includes(value as TValue)
		? (value as TValue)
		: defaultValue;
}

export function getCsvSetting(
	key: string,
	options: SettingSourceOptions = {},
	defaultValue: string[] = [],
): string[] {
	const value = resolveSettingRaw(key, options);
	if (value === undefined) {
		return defaultValue;
	}

	return String(value)
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/**
 * Format Zod config errors consistently so callers do not need to duplicate
 * the same path + message rendering logic.
 *
 * Why: repeated hand-rolled error formatting tends to drift between plugins,
 * which makes startup failures harder to compare and grep in logs.
 */
export function formatConfigErrors(scope: string, error: z.ZodError): string {
	const lines = error.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "config";
		return `- ${path}: ${issue.message}`;
	});

	const details =
		lines.length > 0 ? lines.join("\n") : "- config: Unknown validation error";

	return `${scope} configuration validation failed:\n${details}`;
}

/**
 * Parse a raw config object with a shared error policy.
 *
 * Why: some callers should fail fast on bad config, while others want to opt
 * into a non-throw path and decide their fallback behavior locally.
 */
export function loadPluginConfig<TOutput>({
	schema,
	raw,
	scope,
	onError = "throw",
}: LoadPluginConfigOptions<TOutput>): TOutput | undefined {
	const result = schema.safeParse(raw);
	if (result.success) {
		return result.data;
	}

	if (onError === "return-undefined") {
		return undefined;
	}

	throw new Error(formatConfigErrors(scope, result.error));
}
