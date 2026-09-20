/** Request-local native history identity; selection and authorization remain runtime validated. */
import { HANDLE_RESPONSE_TOOL_NAME } from "../../actions/to-tool";
import { completionContextSources } from "../../runtime/completion-context";
import type { ContextObject } from "../../types/context-object";
import type { GenerateTextResult, JSONSchema } from "../../types/model";
import { parseToolArguments } from "./tool-arguments";

const REQUEST_SOURCE_REFERENCE = "current_request";

/** Capture before dispatch, never from context that may change while awaiting a model. */
export function createSourceSelectionBinding(
	schema: JSONSchema,
	context: ContextObject,
) {
	const completion = schema.properties?.completionContext;
	const identity = completion?.properties?.sourceSetId;
	const snapshot = completionContextSources(context);
	if (
		!completion ||
		identity?.type !== "string" ||
		snapshot.sources.length === 0
	)
		return undefined;
	const sourceSetId = snapshot.sourceSetId;
	const parameters: JSONSchema = {
		...schema,
		properties: {
			...schema.properties,
			completionContext: {
				...completion,
				properties: {
					...completion.properties,
					sourceSetId: {
						type: "string",
						enum: [REQUEST_SOURCE_REFERENCE],
						description:
							"Use current_request. The runtime binds this reference to the exact sources supplied with this model request.",
					},
				},
			},
		},
	};
	return {
		parameters,
		resolve(raw: string | GenerateTextResult): string | GenerateTextResult {
			// Legacy JSON never gets an implicit binding. Nor do actual mismatched hashes.
			if (typeof raw === "string" || !Array.isArray(raw.toolCalls)) return raw;
			return {
				...raw,
				toolCalls: raw.toolCalls.map((entry) => {
					if (!entry || typeof entry !== "object" || Array.isArray(entry))
						return entry;
					const name = String(
						entry.name ?? entry.toolName ?? entry.tool ?? entry.action ?? "",
					).trim();
					if (name !== HANDLE_RESPONSE_TOOL_NAME) return entry;
					const args = parseToolArguments(
						entry.arguments ?? entry.args ?? entry.input ?? entry.params,
					);
					const selection = args?.completionContext;
					if (
						!selection ||
						typeof selection !== "object" ||
						Array.isArray(selection) ||
						(selection as Record<string, unknown>).sourceSetId !==
							REQUEST_SOURCE_REFERENCE
					)
						return entry;
					return {
						...entry,
						arguments: {
							...args,
							completionContext: { ...selection, sourceSetId },
						},
					};
				}),
			};
		},
	};
}
