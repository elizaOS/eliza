/**
 * @module @elizaos/plugin-form
 * @description Guardrails for agent-guided user journeys
 *
 * @author Odilitime
 * @copyright 2025 Odilitime
 * @license MIT
 *
 * ## The Core Insight
 *
 * Forms aren't just about data collection - they're **guardrails for agents**.
 *
 * Without structure, agents wander. They forget context, miss required
 * information, and can't reliably guide users to outcomes. This plugin
 * gives agents the tools to follow conventions and shepherd users through
 * structured journeys - registrations, orders, applications, onboarding flows.
 *
 * **Forms define the path. Agents follow it. Users reach outcomes.**
 *
 * ## Key Features
 *
 * - **Natural Language Extraction**: "I'm John, 25, john@example.com"
 * - **Two-Tier Intent Detection**: Fast English keywords + LLM fallback
 * - **UX Magic**: Undo, skip, explain, example, progress, autofill
 * - **Smart TTL**: Retention scales with user effort
 * - **Fluent Builder API**: Type-safe form definitions
 * - **Extensible Types**: Register custom field types
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                        Form Plugin                          │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                             │
 * │   Provider (FORM_CONTEXT)                                   │
 * │   - Runs BEFORE agent responds                              │
 * │   - Injects form state into context                         │
 * │   - Tells agent what to ask next                            │
 * │                                                             │
 * │   Evaluator (form_evaluator)                                │
 * │   - Runs AFTER each user message                            │
 * │   - Detects intent (submit, cancel, undo, etc.)             │
 * │   - Extracts field values from natural language             │
 * │   - Updates session state                                   │
 * │                                                             │
 * │   Action (FORM_RESTORE)                                     │
 * │   - Preempts REPLY for restore intent                       │
 * │   - Immediately restores stashed forms                      │
 * │                                                             │
 * │   Service (FormService)                                     │
 * │   - Manages form definitions                                │
 * │   - Manages sessions, submissions, autofill                 │
 * │   - Executes lifecycle hooks                                │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Quick Start
 *
 * ### 1. Add plugin to your agent
 *
 * ```typescript
 * import { formPlugin } from '@elizaos/plugin-form';
 *
 * const agent = {
 *   plugins: [formPlugin, ...otherPlugins],
 * };
 * ```
 *
 * ### 2. Define a form
 *
 * ```typescript
 * import { Form, C } from '@elizaos/plugin-form';
 *
 * const registrationForm = Form.create('registration')
 *   .name('User Registration')
 *   .control(C.email('email').required().ask('What email should we use?'))
 *   .control(C.text('name').required().ask("What's your name?"))
 *   .control(C.number('age').min(13))
 *   .onSubmit('handle_registration')
 *   .build();
 * ```
 *
 * ### 3. Register and start
 *
 * ```typescript
 * // In your plugin init:
 * const formService = runtime.getService('FORM') as FormService;
 * formService.registerForm(registrationForm);
 *
 * // When you need to collect data:
 * await formService.startSession('registration', entityId, roomId);
 * ```
 *
 * ### 4. Handle submissions
 *
 * ```typescript
 * runtime.registerTaskWorker({
 *   name: 'handle_registration',
 *   execute: async (runtime, options) => {
 *     const { submission } = options;
 *     const { email, name, age } = submission.values;
 *     // Create user account, etc.
 *   }
 * });
 * ```
 *
 * ## User Experience
 *
 * The form plugin handles these user interactions:
 *
 * | User Says | Intent | Result |
 * |-----------|--------|--------|
 * | "I'm John, 25 years old" | fill_form | Extract name=John, age=25 |
 * | "done" / "submit" | submit | Submit the form |
 * | "save for later" | stash | Save and switch contexts |
 * | "resume my form" | restore | Restore stashed form |
 * | "cancel" / "nevermind" | cancel | Abandon form |
 * | "undo" / "go back" | undo | Revert last change |
 * | "skip" | skip | Skip optional field |
 * | "why?" | explain | Explain current field |
 * | "example?" | example | Show example value |
 * | "how far?" | progress | Show completion status |
 * | "same as last time" | autofill | Use saved values |
 *
 * ## Module Exports
 *
 * - **Types**: FormControl, FormDefinition, FormSession, etc.
 * - **Builder**: Form, C (ControlBuilder)
 * - **Service**: FormService
 * - **Utilities**: validateField, parseValue, formatValue
 * - **Plugin**: formPlugin (default export)
 *
 * @see {@link FormService} for form management API
 * @see {@link FormBuilder} for fluent form definition
 * @see {@link ControlBuilder} for field definition
 */

import type { Plugin, IAgentRuntime } from "@elizaos/core";

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
  BUILTIN_TYPES,
  BUILTIN_TYPE_MAP,
  registerBuiltinTypes,
  getBuiltinType,
  isBuiltinType,
} from "./builtins";

// ============================================================================
// VALIDATION EXPORTS
// Field validation, type coercion, and custom type registration
// ============================================================================

export {
  validateField,
  formatValue,
  parseValue,
  matchesMimeType,
} from "./validation";
export {
  registerTypeHandler,
  getTypeHandler,
  clearTypeHandlers,
} from "./validation";

// ============================================================================
// INTENT DETECTION EXPORTS
// Two-tier intent detection (fast path + LLM fallback)
// ============================================================================

export {
  quickIntentDetect,
  isLifecycleIntent,
  isUXIntent,
  hasDataToExtract,
} from "./intent";

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
} from "./storage";

// ============================================================================
// EXTRACTION EXPORTS
// LLM-based field extraction from natural language
// ============================================================================

export {
  llmIntentAndExtract,
  extractSingleField,
  detectCorrection,
} from "./extraction";

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

export { FormBuilder, ControlBuilder, Form, C } from "./builder";

// ============================================================================
// SERVICE EXPORT
// Central form management service
// ============================================================================

export { FormService } from "./service";

// ============================================================================
// COMPONENT EXPORTS
// Provider, Evaluator, Action, Tasks
// ============================================================================

// Provider - injects form context into agent state
export { formContextProvider } from "./providers/context";

// Evaluator - extracts fields and handles intents
export { formEvaluator } from "./evaluators/extractor";

// Action - fast-path restore for stashed forms
export { formRestoreAction } from "./actions/restore";

// Tasks - background processing for nudges and cleanup
export { formNudgeWorker, processEntityNudges } from "./tasks/nudge";

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Form Plugin
 *
 * Infrastructure plugin for collecting structured data through natural conversation.
 *
 * Architecture:
 * - Provider: Injects form state into agent context before response
 * - Evaluator: Extracts fields and handles intents after response
 * - Action: Fast-path restore for stashed forms
 * - Service: Manages form definitions, sessions, and submissions
 *
 * Usage:
 * 1. Register form definitions via FormService.registerForm()
 * 2. Start sessions via FormService.startSession()
 * 3. The evaluator automatically extracts field values from user messages
 * 4. The provider gives the agent context about what to ask next
 * 5. The agent (via REPLY) handles the conversation naturally
 */
export const formPlugin: Plugin = {
  name: "form",
  description: "Agent-native conversational forms for data collection",

  // Service for form management
  services: [
    // FormService is registered as a static class
    // It will be instantiated by the runtime
    {
      serviceType: "FORM",
      start: async (runtime: IAgentRuntime) => {
        const { FormService } = await import("./service");
        return FormService.start(runtime);
      },
    } as any,
  ],

  // Provider for form context
  providers: [
    // Import dynamically to avoid circular deps
    {
      name: "FORM_CONTEXT",
      description: "Provides context about active form sessions",
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
      validate: async (runtime, message, state) => {
        const { formRestoreAction } = await import("./actions/restore");
        return formRestoreAction.validate(runtime, message, state);
      },
      handler: async (runtime, message, state, options, callback) => {
        const { formRestoreAction } = await import("./actions/restore");
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
