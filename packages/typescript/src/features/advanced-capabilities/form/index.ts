/**
 * @module form
 * @description Guardrails for agent-guided user journeys
 *
 * Conversational forms for data collection in elizaOS.
 */

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export * from "./types.ts";

// ============================================================================
// BUILT-IN TYPES EXPORTS
// ============================================================================

export {
	BUILTIN_TYPE_MAP,
	BUILTIN_TYPES,
	getBuiltinType,
	isBuiltinType,
	registerBuiltinTypes,
} from "./builtins.ts";

// ============================================================================
// VALIDATION EXPORTS
// ============================================================================

export {
	clearTypeHandlers,
	formatValue,
	getTypeHandler,
	matchesMimeType,
	parseValue,
	registerTypeHandler,
	validateField,
} from "./validation.ts";

// ============================================================================
// INTENT DETECTION EXPORTS
// ============================================================================

export {
	hasDataToExtract,
	isLifecycleIntent,
	isUXIntent,
	quickIntentDetect,
} from "./intent.ts";

// ============================================================================
// STORAGE EXPORTS
// ============================================================================

export {
	deleteSession,
	getActiveSession,
	getAllActiveSessions,
	getAutofillData,
	getStashedSessions,
	getSubmissions,
	saveAutofillData,
	saveSession,
	saveSubmission,
} from "./storage.ts";

// ============================================================================
// EXTRACTION EXPORTS
// ============================================================================

export {
	detectCorrection,
	extractSingleField,
	llmIntentAndExtract,
} from "./extraction.ts";

// ============================================================================
// TTL & EFFORT EXPORTS
// ============================================================================

export {
	calculateTTL,
	formatEffort,
	formatTimeRemaining,
	isExpired,
	isExpiringSoon,
	shouldConfirmCancel,
	shouldNudge,
} from "./ttl.ts";

// ============================================================================
// DEFAULTS EXPORTS
// ============================================================================

export {
	applyControlDefaults,
	applyFormDefaults,
	prettify,
} from "./defaults.ts";

// ============================================================================
// TEMPLATE EXPORTS
// ============================================================================

export type { TemplateValues } from "./template.ts";
export {
	buildTemplateValues,
	renderTemplate,
	resolveControlTemplates,
} from "./template.ts";

// ============================================================================
// BUILDER API EXPORTS
// ============================================================================

export { C, ControlBuilder, Form, FormBuilder } from "./builder.ts";

// ============================================================================
// SERVICE EXPORT
// ============================================================================

// FormService is lazy-loaded in advancedServices (advanced-capabilities/index.ts)
// to avoid circular dependency with @elizaos/core
export type { FormService } from "./service.ts";

// ============================================================================
// COMPONENT EXPORTS
// ============================================================================

// Action - fast-path restore for stashed forms
export { formRestoreAction } from "./actions/restore.ts";

// Evaluator - extracts fields and handles intents
export { formEvaluator } from "./evaluators/extractor.ts";

// Provider - injects form context into agent state
export { formContextProvider } from "./providers/context.ts";
