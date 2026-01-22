/**
 * @module @elizaos/plugin-form
 * @description Guardrails for agent-guided user journeys
 *
 * @author Odilitime
 * @copyright 2025 Odilitime
 * @license MIT
 */

import type { Plugin, IAgentRuntime } from "@elizaos/core";

// ============================================================================
// TYPE EXPORTS
// ============================================================================

// Types - all interfaces and type definitions
export * from "./src/types";

// ============================================================================
// BUILT-IN TYPES EXPORTS
// Pre-registered control types (text, number, email, etc.)
// ============================================================================

export {
  BUILTIN_TYPES,
  BUILTIN_TYPE_MAP,
  registerBuiltinTypes,
  getBuiltinType,
  isBuiltinType,
} from "./src/builtins";

// ============================================================================
// VALIDATION EXPORTS
// Field validation, type coercion, and custom type registration
// ============================================================================

export {
  validateField,
  formatValue,
  parseValue,
  matchesMimeType,
} from "./src/validation";
export {
  registerTypeHandler,
  getTypeHandler,
  clearTypeHandlers,
} from "./src/validation";

// ============================================================================
// INTENT DETECTION EXPORTS
// Two-tier intent detection (fast path + LLM fallback)
// ============================================================================

export {
  quickIntentDetect,
  isLifecycleIntent,
  isUXIntent,
  hasDataToExtract,
} from "./src/intent";

// ============================================================================
// STORAGE EXPORTS
// Component-based persistence for sessions, submissions, autofill
// ============================================================================

export {
  getActiveSession,
  getAllActiveSessions,
  getStashedSessions,
  saveSession,
  deleteSession,
  saveSubmission,
  getSubmissions,
  getAutofillData,
  saveAutofillData,
} from "./src/storage";

// ============================================================================
// EXTRACTION EXPORTS
// LLM-based field extraction from natural language
// ============================================================================

export {
  llmIntentAndExtract,
  extractSingleField,
  detectCorrection,
} from "./src/extraction";

// ============================================================================
// TTL & EFFORT EXPORTS
// Smart retention based on user effort
// ============================================================================

export {
  calculateTTL,
  shouldNudge,
  isExpiringSoon,
  isExpired,
  shouldConfirmCancel,
  formatTimeRemaining,
  formatEffort,
} from "./src/ttl";

// ============================================================================
// DEFAULTS EXPORTS
// Sensible default value application
// ============================================================================

export { applyControlDefaults, applyFormDefaults, prettify } from "./src/defaults";

// ============================================================================
// BUILDER API EXPORTS
// Fluent API for defining forms and controls
// ============================================================================

export { FormBuilder, ControlBuilder, Form, C } from "./src/builder";

// ============================================================================
// SERVICE EXPORT
// Central form management service
// ============================================================================

export { FormService } from "./src/service";

// ============================================================================
// COMPONENT EXPORTS
// Provider, Evaluator, Action, Tasks
// ============================================================================

// Provider - injects form context into agent state
export { formContextProvider } from "./src/providers/context";

// Evaluator - extracts fields and handles intents
export { formEvaluator } from "./src/evaluators/extractor";

// Action - fast-path restore for stashed forms
export { formRestoreAction } from "./src/actions/restore";

// Tasks - background processing for nudges and cleanup
export { formNudgeWorker, processEntityNudges } from "./src/tasks/nudge";

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Form Plugin
 *
 * Infrastructure plugin for collecting structured data through natural conversation.
 */
export const formPlugin: Plugin = {
  name: "form",
  description: "Agent-native conversational forms for data collection",

  // Service for form management
  services: [
    {
      serviceType: "FORM",
      start: async (runtime: IAgentRuntime) => {
        const { FormService } = await import("./src/service");
        return FormService.start(runtime);
      },
    } as any,
  ],

  // Provider for form context
  providers: [
    {
      name: "FORM_CONTEXT",
      description: "Provides context about active form sessions",
      get: async (runtime, message, state) => {
        const { formContextProvider } = await import("./src/providers/context");
        return formContextProvider.get(runtime, message, state);
      },
    },
  ],

  // Evaluator for field extraction
  evaluators: [
    {
      name: "form_evaluator",
      description: "Extracts form fields and handles form intents",
      similes: ["FORM_EXTRACTION", "FORM_HANDLER"],
      examples: [],
      validate: async (runtime, message, state) => {
        const { formEvaluator } = await import("./src/evaluators/extractor");
        return formEvaluator.validate(runtime, message, state);
      },
      handler: async (runtime, message, state) => {
        const { formEvaluator } = await import("./src/evaluators/extractor");
        return formEvaluator.handler(runtime, message, state);
      },
    },
  ],

  // Action for restoring stashed forms
  actions: [
    {
      name: "FORM_RESTORE",
      similes: ["RESUME_FORM", "CONTINUE_FORM"],
      description: "Restore a previously stashed form session",
      validate: async (runtime, message, state) => {
        const { formRestoreAction } = await import("./src/actions/restore");
        return formRestoreAction.validate(runtime, message, state);
      },
      handler: async (runtime, message, state, options, callback) => {
        const { formRestoreAction } = await import("./src/actions/restore");
        return formRestoreAction.handler(
          runtime,
          message,
          state,
          options,
          callback,
        );
      },
      examples: [
        [
          {
            name: "{{user1}}",
            content: { text: "Resume my form" },
          },
          {
            name: "{{agentName}}",
            content: {
              text: "I've restored your form. Let's continue where you left off.",
            },
          },
        ],
      ],
    },
  ],
};

export default formPlugin;
