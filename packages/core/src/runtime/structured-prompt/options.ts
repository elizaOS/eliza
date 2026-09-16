/** Resolves structured prompt model, output, streaming, and provider cache options. */
import {
	type JsonValue,
	ModelType,
	type TextGenerationModelType,
} from "../../types";
import type { SchemaRow } from "../../types/state";
import type { StructuredResponseFormat } from "./types";

export function resolveDynamicPromptModelType(
	modelType?: TextGenerationModelType,
	modelSize?: "nano" | "small" | "medium" | "large" | "mega",
): TextGenerationModelType {
	if (modelType) {
		return modelType;
	}

	switch (modelSize) {
		case "nano":
			return ModelType.TEXT_NANO;
		case "small":
			return ModelType.TEXT_SMALL;
		case "medium":
			return ModelType.TEXT_MEDIUM;
		case "mega":
			return ModelType.TEXT_MEGA;
		default:
			return ModelType.TEXT_LARGE;
	}
}

/**
 * Resolves the default structured-output format from a setting value.
 * Used by `dynamicPromptExecFromState` when no per-call preference is given.
 */
export function resolveDefaultOutputFormat(
	raw: unknown,
): StructuredResponseFormat {
	if (typeof raw !== "string") return "JSON";
	switch (raw.trim().toLowerCase()) {
		case "json":
			return "JSON";
		default:
			return "JSON";
	}
}

export const DEFAULT_DYNAMIC_PROMPT_STREAM_FIELDS = new Set(["text"]);

/**
 * Resolve which structured fields stream to the consumer for the line-oriented
 * `dynamicPromptExecFromState` path. A field streams when it opts in with
 * `streamField: true`, or — when it expresses no preference — when its name is
 * in {@link DEFAULT_DYNAMIC_PROMPT_STREAM_FIELDS} (the clean reply `text`).
 * `streamField: false` always opts out. Exported for regression coverage of
 * the default token-stream contract (#9174).
 */
export function resolveDynamicPromptStreamFields(
	schema: readonly SchemaRow[],
): string[] {
	return schema
		.filter((row) => {
			if (row.streamField === true) {
				return true;
			}
			if (row.streamField === false) {
				return false;
			}
			return DEFAULT_DYNAMIC_PROMPT_STREAM_FIELDS.has(row.field);
		})
		.map((row) => row.field);
}

/**
 * Merges provider options from three sources: a base object (e.g. `{ agentName }`),
 * optional caller-supplied options, and a cache-plan's options. Caller fields take
 * precedence over base; plan fields take precedence over caller on key collision, but
 * named provider sub-objects (e.g. `anthropic`, `openai`) are merged one level deep so
 * caller-specific fields like `anthropic.thinking` survive alongside plan additions like
 * `anthropic.cacheControl`.
 *
 * Exported so tests can import and exercise the real function rather than maintaining a
 * hand-copied mirror that cannot catch regressions in this code path.
 */
export function mergeProviderOptionsWithCachePlan(
	base: Record<string, JsonValue | object | undefined>,
	callerOptions: Record<string, JsonValue | object | undefined> | undefined,
	planOptions: Record<string, JsonValue | object | undefined>,
): Record<string, JsonValue | object | undefined> {
	const merged: Record<string, JsonValue | object | undefined> = {
		...base,
		...callerOptions,
	};
	for (const [key, planValue] of Object.entries(planOptions)) {
		const existing = merged[key];
		merged[key] =
			existing != null &&
			typeof existing === "object" &&
			!Array.isArray(existing) &&
			planValue != null &&
			typeof planValue === "object" &&
			!Array.isArray(planValue)
				? {
						...(existing as Record<string, unknown>),
						...(planValue as Record<string, unknown>),
					}
				: planValue;
	}
	return merged;
}
