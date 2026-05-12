/**
 * @module @elizaos/plugin-form
 * @description Guardrails for agent-guided user journeys
 *
 * @author Odilitime
 * @copyright 2025 Odilitime
 * @license MIT
 */

import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { formEvaluator } from "./evaluators/extractor";

export { formAction, formRestoreAction } from "./actions/form";
export { C, ControlBuilder, Form, FormBuilder } from "./builder";
export {
  BUILTIN_TYPE_MAP,
  BUILTIN_TYPES,
  getBuiltinType,
  isBuiltinType,
  registerBuiltinTypes,
} from "./builtins";
export { applyControlDefaults, applyFormDefaults, prettify } from "./defaults";
export { formEvaluator } from "./evaluators/extractor";
export {
  buildFormExtractorPromptSection,
  buildFormExtractorSchema,
  coerceExtractionsAgainstControls,
  detectCorrection,
  extractSingleField,
  parseFormExtractorOutput,
} from "./extraction";
export { formContextProvider } from "./providers/context";
export { FormService } from "./service";
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
export {
  calculateTTL,
  formatEffort,
  formatTimeRemaining,
  isExpired,
  isExpiringSoon,
  shouldConfirmCancel,
  shouldNudge,
} from "./ttl";
export * from "./types";
export {
  clearTypeHandlers,
  formatValue,
  getTypeHandler,
  matchesMimeType,
  parseValue,
  registerTypeHandler,
  validateField,
} from "./validation";

/**
 * Form Plugin
 *
 * Infrastructure plugin for collecting structured data through natural conversation.
 */
export const formPlugin = {
  name: "form",
  description: "Agent-native conversational forms for data collection",
  descriptionCompressed: "Conversational forms for structured data collection.",

  autoEnable: {
    shouldEnable: (
      _env: Record<string, string | undefined>,
      config: Record<string, unknown>,
    ) => {
      const f = (config?.features as Record<string, unknown> | undefined)?.form;
      return (
        f === true ||
        (typeof f === "object" &&
          f !== null &&
          (f as { enabled?: unknown }).enabled !== false)
      );
    },
  },

  services: [
    {
      serviceType: "FORM",
      start: async (runtime: IAgentRuntime) => {
        const { FormService } = await import("./service");
        return FormService.start(runtime);
      },
    } as ServiceClass,
  ],

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

  actions: [],
  evaluators: [formEvaluator],
} as Plugin & { descriptionCompressed?: string };

export default formPlugin;
