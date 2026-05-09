import {
	createHandleResponseTool,
	HANDLE_RESPONSE_DIRECT_SCHEMA,
	HANDLE_RESPONSE_EXTRACT_SCHEMA,
	HANDLE_RESPONSE_SCHEMA,
	HANDLE_RESPONSE_TOOL_NAME,
} from "../actions/to-tool";
import { messageHandlerTemplate } from "../prompts";
import type { JSONSchema, ToolDefinition } from "../types/model";

/**
 * Stage 1 tool name. Re-exported here so prompts and template strings can
 * use the canonical constant without pulling in the full action surface.
 */
export const V5_MESSAGE_HANDLER_TOOL_NAME = HANDLE_RESPONSE_TOOL_NAME;

/**
 * The Stage 1 message-handler prompt. Single source of truth lives in
 * `packages/prompts/prompts/message_handler.txt` and is generated into
 * `core/src/prompts.ts`. Re-exported here under the legacy `v5*` name
 * for back-compat with existing call sites.
 *
 * Template variables (substitute at compose time):
 *   - {{availableContexts}} — formatted list of registered context ids
 *   - {{handleResponseToolName}} — pass {@link HANDLE_RESPONSE_TOOL_NAME}
 *   - {{#if directMessage}} — set true to switch to direct-message variant
 */
export const v5MessageHandlerTemplate = messageHandlerTemplate;
export const V5_MESSAGE_HANDLER_TEMPLATE = v5MessageHandlerTemplate;

/**
 * Re-exported for downstream callers that need the raw schemas (e.g.
 * trajectory replay validators). New code should reach for the schemas
 * via `actions/to-tool.ts` directly.
 */
export const v5MessageHandlerExtractSchema: JSONSchema =
	HANDLE_RESPONSE_EXTRACT_SCHEMA;

export const v5MessageHandlerSchema: JSONSchema = HANDLE_RESPONSE_SCHEMA;

export const V5_MESSAGE_HANDLER_SCHEMA = v5MessageHandlerSchema;

export const v5DirectMessageHandlerSchema: JSONSchema =
	HANDLE_RESPONSE_DIRECT_SCHEMA;

export const V5_DIRECT_MESSAGE_HANDLER_SCHEMA = v5DirectMessageHandlerSchema;

/**
 * Build the Stage 1 tool definition. Thin wrapper around
 * {@link createHandleResponseTool} kept for backward compatibility with
 * existing call sites.
 */
export function createV5MessageHandlerTool(options?: {
	directMessage?: boolean;
}): ToolDefinition {
	return createHandleResponseTool(options);
}
