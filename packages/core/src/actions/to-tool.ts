import type { Action } from "../types";
import {
	type ActionParametersJsonSchema,
	actionToJsonSchema,
} from "./action-schema";

export const NATIVE_TOOL_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: ActionParametersJsonSchema;
		strict: true;
	};
}

export function assertNativeToolName(name: string): void {
	if (!NATIVE_TOOL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid tool name '${name}'. Native tool names must match ${NATIVE_TOOL_NAME_PATTERN}.`,
		);
	}
}

export function actionToTool(action: Action): ToolDefinition {
	assertNativeToolName(action.name);

	return {
		type: "function",
		function: {
			name: action.name,
			description:
				action.descriptionCompressed ??
				action.compressedDescription ??
				action.description,
			parameters: actionToJsonSchema(action),
			strict: true,
		},
	};
}
