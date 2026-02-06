/**
 * @module providers/context
 * @description Form context provider for agent awareness
 *
 * ## Purpose
 *
 * This provider injects form state into the agent's context BEFORE
 * the agent generates a response. This allows the agent to:
 *
 * 1. Know if a form is active
 * 2. Know what fields have been filled
 * 3. Know what fields are missing
 * 4. Know what needs confirmation
 * 5. Know what to ask next
 *
 * ## How It Works
 *
 * ```
 * User Message → Provider Runs → Agent Gets Context → Agent Responds
 *                    ↓
 *              FormContextState
 *                    ↓
 *              - hasActiveForm: true
 *              - progress: 60%
 *              - nextField: "email"
 *              - uncertainFields: [...]
 * ```
 *
 * ## Context Output
 *
 * The provider outputs:
 *
 * - `data`: Full FormContextState object (for programmatic access)
 * - `values`: String values for template substitution
 * - `text`: Human-readable summary for agent
 *
 * The `text` output is structured markdown that the agent can use
 * to understand the form state and craft appropriate responses.
 *
 * ## Agent Guidance
 *
 * The provider includes "Agent Guidance" in the text output, giving
 * the agent explicit suggestions:
 *
 * - "Ask for their email"
 * - "Confirm: 'I understood X as Y. Is that correct?'"
 * - "All fields collected! Nudge user to submit."
 *
 * ## Stashed Forms
 *
 * If the user has stashed forms, the provider mentions this so
 * the agent can remind the user they have unfinished work.
 */

import type {
  IAgentRuntime,
  JsonValue,
  Memory,
  Provider,
  ProviderResult,
  State,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { FormService } from "../service";
import type { FormContextState } from "../types";
import {
  buildTemplateValues,
  renderTemplate,
  resolveControlTemplates,
} from "../template";

/**
 * Form Context Provider
 *
 * Injects the current form state into the agent's context,
 * allowing the agent to respond naturally about form progress
 * and ask for missing fields.
 *
 * WHY a provider (not evaluator):
 * - Providers run BEFORE response generation
 * - Agent needs context to generate appropriate response
 * - Evaluator runs AFTER, too late for response
 */
export const formContextProvider: Provider = {
  name: "FORM_CONTEXT",
  description: "Provides context about active form sessions",

  /**
   * Get form context for the current message.
   *
   * @param runtime - Agent runtime for service access
   * @param message - The user message being processed
   * @param _state - Current agent state (unused)
   * @returns Provider result with form context
   */
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      // Get form service
      // WHY type cast: Runtime returns unknown, we know it's FormService
      const formService = runtime.getService("FORM") as FormService;
      if (!formService) {
        return {
          data: { hasActiveForm: false },
          values: { formContext: "" },
          text: "",
        };
      }

      // Get entity and room IDs
      // WHY UUID cast: Memory has these as unknown, we need proper typing
      const entityId = message.entityId as UUID;
      const roomId = message.roomId as UUID;

      if (!entityId || !roomId) {
        return {
          data: { hasActiveForm: false },
          values: { formContext: "" },
          text: "",
        };
      }

      // Get active session for this room
      const session = await formService.getActiveSession(entityId, roomId);

      // Get stashed sessions (for "you have saved forms" prompt)
      const stashed = await formService.getStashedSessions(entityId);

      // If no active session and no stashed, nothing to provide
      if (!session && stashed.length === 0) {
        return {
          data: { hasActiveForm: false, stashedCount: 0 },
          values: { formContext: "" },
          text: "",
        };
      }

      // Build context for active session
      let contextText = "";
      let contextState: FormContextState;

      if (session) {
        // Get session context from service
        contextState = formService.getSessionContext(session);
        const form = formService.getForm(session.formId);
        const templateValues = buildTemplateValues(session);
        const resolveText = (value?: string): string | undefined =>
          renderTemplate(value, templateValues);

        contextState = {
          ...contextState,
          filledFields: contextState.filledFields.map((field) => ({
            ...field,
            label: resolveText(field.label) ?? field.label,
          })),
          missingRequired: contextState.missingRequired.map((field) => ({
            ...field,
            label: resolveText(field.label) ?? field.label,
            description: resolveText(field.description),
            askPrompt: resolveText(field.askPrompt),
          })),
          uncertainFields: contextState.uncertainFields.map((field) => ({
            ...field,
            label: resolveText(field.label) ?? field.label,
          })),
          nextField: contextState.nextField
            ? resolveControlTemplates(contextState.nextField, templateValues)
            : null,
        };

        // Build human-readable context for agent
        // WHY markdown: Agent can parse and use structure
        contextText = `# Active Form: ${form?.name || session.formId}\n\n`;

        // Progress indicator
        contextText += `Progress: ${contextState.progress}%\n\n`;

        // Filled fields - what we already have
        // WHY show filled: Agent can reference in conversation
        if (contextState.filledFields.length > 0) {
          contextText += `## Collected Information\n`;
          for (const field of contextState.filledFields) {
            contextText += `- ${field.label}: ${field.displayValue}\n`;
          }
          contextText += "\n";
        }

        // Missing required fields - what we still need
        // WHY show missing: Agent knows what to ask for
        if (contextState.missingRequired.length > 0) {
          contextText += `## Still Needed\n`;
          for (const field of contextState.missingRequired) {
            contextText += `- ${field.label}${field.description ? ` (${field.description})` : ""}\n`;
          }
          contextText += "\n";
        }

        // Uncertain fields needing confirmation
        // WHY show uncertain: Agent should ask user to confirm
        if (contextState.uncertainFields.length > 0) {
          contextText += `## Needs Confirmation\n`;
          for (const field of contextState.uncertainFields) {
            contextText += `- ${field.label}: "${field.value}" (${Math.round(field.confidence * 100)}% confident)\n`;
          }
          contextText += "\n";
        }

        // Pending external fields (payments, signatures, etc.)
        // WHY show pending: Agent should remind user of outstanding actions
        if (contextState.pendingExternalFields.length > 0) {
          contextText += `## Waiting For External Action\n`;
          for (const field of contextState.pendingExternalFields) {
            const ageMs = Date.now() - field.activatedAt;
            const ageMin = Math.floor(ageMs / 60000);
            const ageText = ageMin < 1 ? "just now" : `${ageMin}m ago`;
            contextText += `- ${field.label}: ${field.instructions} (started ${ageText})\n`;
            if (field.address) {
              contextText += `  Address: ${field.address}\n`;
            }
          }
          contextText += "\n";
        }

        // Explicit agent guidance
        // WHY guidance: Tells agent exactly what to do next
        contextText += `## Agent Guidance\n`;

        if (contextState.pendingExternalFields.length > 0) {
          // We're waiting for external confirmation (payment, signature, etc.)
          const pending = contextState.pendingExternalFields[0];
          contextText += `Waiting for external action. Remind user: "${pending.instructions}"\n`;
        } else if (contextState.pendingCancelConfirmation) {
          // User wants to cancel a high-effort form
          contextText += `User is trying to cancel. Confirm: "You've spent time on this. Are you sure you want to cancel?"\n`;
        } else if (contextState.uncertainFields.length > 0) {
          // Need to confirm an uncertain value
          const uncertain = contextState.uncertainFields[0];
          contextText += `Ask user to confirm: "I understood your ${uncertain.label} as '${uncertain.value}'. Is that correct?"\n`;
        } else if (contextState.nextField) {
          // Ask for the next field
          const next = contextState.nextField;
          const prompt = next.askPrompt || `Ask for their ${next.label}`;
          contextText += `Next: ${prompt}\n`;
          if (next.example) {
            contextText += `Example: "${next.example}"\n`;
          }
        } else if (contextState.status === "ready") {
          // All required fields done, suggest submit
          contextText += `All fields collected! Nudge user to submit: "I have everything I need. Ready to submit?"\n`;
        }

        contextText += "\n";

        // User commands reference
        // WHY: Agent should know what user can say
        contextText += `## User Can Say\n`;
        contextText += `- Provide information for any field\n`;
        contextText += `- "undo" or "go back" to revert last change\n`;
        contextText += `- "skip" to skip optional fields\n`;
        contextText += `- "why?" to get explanation about a field\n`;
        contextText += `- "how far?" to check progress\n`;
        contextText += `- "submit" or "done" when ready\n`;
        contextText += `- "save for later" to stash the form\n`;
        contextText += `- "cancel" to abandon the form\n`;
      } else {
        // No active session, just stashed info
        contextState = {
          hasActiveForm: false,
          progress: 0,
          filledFields: [],
          missingRequired: [],
          uncertainFields: [],
          nextField: null,
          stashedCount: stashed.length,
          pendingExternalFields: [],
        };
      }

      // Stashed forms reminder
      // WHY: User might have forgotten about saved forms
      if (stashed.length > 0) {
        contextText += `\n## Saved Forms\n`;
        contextText += `User has ${stashed.length} saved form(s). They can say "resume" or "continue" to restore one.\n`;
        for (const s of stashed) {
          const form = formService.getForm(s.formId);
          const ctx = formService.getSessionContext(s);
          contextText += `- ${form?.name || s.formId} (${ctx.progress}% complete)\n`;
        }
      }

      return {
        // Full context object for programmatic access
        data: JSON.parse(JSON.stringify(contextState)) as Record<
          string,
          JsonValue
        >,
        // String values for template substitution
        values: {
          formContext: contextText,
          hasActiveForm: String(contextState.hasActiveForm),
          formProgress: String(contextState.progress),
          formStatus: contextState.status || "",
          stashedCount: String(stashed.length),
        },
        // Human-readable text for agent
        text: contextText,
      };
    } catch (error) {
      logger.error("[FormContextProvider] Error:", String(error));
      return {
        data: { hasActiveForm: false, error: true },
        values: { formContext: "Error loading form context." },
        text: "Error loading form context.",
      };
    }
  },
};

export default formContextProvider;
