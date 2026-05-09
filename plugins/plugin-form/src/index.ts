/**
 * @module @elizaos/plugin-form
 * @description Guardrails for agent-guided user journeys
 *
 * @author Odilitime
 * @copyright 2025 Odilitime
 * @license MIT
 */

import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { formRestoreAction } from "./actions/restore";
import { formEvaluator } from "./evaluators/extractor";

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
// Provider, Action, Tasks
// ============================================================================

// Action - fast-path restore for stashed forms
export { formRestoreAction } from "./actions/restore";

// Post-message hook - extracts fields and handles intents
// (Action with mode: ActionMode.ALWAYS_AFTER)
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
export const formPlugin = {
  name: "form",
  description: "Agent-native conversational forms for data collection",
  descriptionCompressed: "Conversational forms for structured data collection.",

  // Self-declared auto-enable: activate when features.form is enabled.
  autoEnable: {
    shouldEnable: (_env: Record<string, string | undefined>, config: Record<string, unknown>) => {
      const f = (config?.features as Record<string, unknown> | undefined)
        ?.form;
      return (
        f === true ||
        (typeof f === "object" &&
          f !== null &&
          (f as { enabled?: unknown }).enabled !== false)
      );
    },
  },

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

  // Action for restoring stashed forms before normal reply generation,
  // plus the form-extraction post-message hook (mode: ALWAYS_AFTER).
  actions: [formRestoreAction, formEvaluator],
} as Plugin & { descriptionCompressed?: string };

export default formPlugin;
