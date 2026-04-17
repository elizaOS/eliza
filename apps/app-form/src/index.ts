/**
 * @module @elizaos/app-form
 * @description Guardrails for agent-guided user journeys
 *
 * @author Odilitime
 * @copyright 2025 Odilitime
 * @license MIT
 */

import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";

// ============================================================================
// TYPE EXPORTS
// ============================================================================

// Types - all interfaces and type definitions
export * from "./types";

// ============================================================================
// BUILT-IN TYPES EXPORTS
// Pre-registered control types (text, number, email, etc.)
// ============================================================================

export {
  BUILTIN_TYPE_MAP,
  BUILTIN_TYPES,
  getBuiltinType,
  isBuiltinType,
  registerBuiltinTypes,
} from "./builtins";

// ============================================================================
// VALIDATION EXPORTS
// Field validation, type coercion, and custom type registration
// ============================================================================

export {
  clearTypeHandlers,
  formatValue,
  getTypeHandler,
  matchesMimeType,
  parseValue,
  registerTypeHandler,
  validateField,
} from "./validation";

// ============================================================================
// INTENT DETECTION EXPORTS
// Two-tier intent detection (fast path + LLM fallback)
// ============================================================================

export {
  hasDataToExtract,
  isLifecycleIntent,
  isUXIntent,
  quickIntentDetect,
} from "./intent";

// ============================================================================
// STORAGE EXPORTS
// Component-based persistence for sessions, submissions, autofill
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
} from "./storage";

// ============================================================================
// EXTRACTION EXPORTS
// LLM-based field extraction from natural language
// ============================================================================

export {
  detectCorrection,
  extractSingleField,
  llmIntentAndExtract,
} from "./extraction";

// ============================================================================
// TTL & EFFORT EXPORTS
// Smart retention based on user effort
// ============================================================================

export {
  calculateTTL,
  formatEffort,
  formatTimeRemaining,
  isExpired,
  isExpiringSoon,
  shouldConfirmCancel,
  shouldNudge,
} from "./ttl";

// ============================================================================
// DEFAULTS EXPORTS
// Sensible default value application
// ============================================================================

export { applyControlDefaults, applyFormDefaults, prettify } from "./defaults";

// ============================================================================
// BUILDER API EXPORTS
// Fluent API for defining forms and controls
// ============================================================================

export { C, ControlBuilder, Form, FormBuilder } from "./builder";

// ============================================================================
// SERVICE EXPORT
// Central form management service
// ============================================================================

export { FormService } from "./service";

// ============================================================================
// COMPONENT EXPORTS
// Provider, Evaluator, Action, Tasks
// ============================================================================

// Action - fast-path restore for stashed forms
export { formRestoreAction } from "./actions/restore";

// Evaluator - extracts fields and handles intents
export { formEvaluator } from "./evaluators/extractor";
// Provider - injects form context into agent state
export { formContextProvider } from "./providers/context";

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
  descriptionCompressed: "Conversational forms for structured data collection.",

  // Service for form management
  services: [
    {
      serviceType: "FORM",
      start: async (runtime: IAgentRuntime) => {
        const { FormService } = await import("./service");
        return FormService.start(runtime);
      },
    } as ServiceClass,
  ],

  // Provider for form context
  providers: [
    {
      name: "FORM_CONTEXT",
      description: "Provides context about active form sessions",
      descriptionCompressed: "Active form session context.",
      get: async (runtime, message, state) => {
        const { formContextProvider } = await import("./providers/context");
        return formContextProvider.get(runtime, message, state);
      },
    },
  ],

  // Evaluator for field extraction
  evaluators: [
    {
      name: "form_evaluator",
      description: "Extracts form fields and handles form intents",
      descriptionCompressed: "Extract form fields and handle form intents.",
      similes: ["FORM_EXTRACTION", "FORM_HANDLER"],
      examples: [],
      validate: async (runtime, message, state) => {
        const { formEvaluator } = await import("./evaluators/extractor");
        return formEvaluator.validate(runtime, message, state);
      },
      handler: async (runtime, message, state) => {
        const { formEvaluator } = await import("./evaluators/extractor");
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
      descriptionCompressed: "Restore stashed form session.",
      validate: async (runtime, message, state) => {
        const { formRestoreAction } = await import("./actions/restore");
        return formRestoreAction.validate(runtime, message, state);
      },
      handler: async (runtime, message, state, options, callback) => {
        const { formRestoreAction } = await import("./actions/restore");
        return formRestoreAction.handler(runtime, message, state, options, callback);
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
