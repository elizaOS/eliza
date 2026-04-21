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
 * 2. Know what required/optional fields we have vs don't have
 * 3. Know what needs confirmation (low-confidence extractions)
 * 4. Know what external actions are pending (payments, signatures, etc.)
 * 5. Get a single, coherent instruction (nudge for required, confirm, or submit)
 *
 * ## Output layout
 *
 * The text output uses a required/optional × have/don't-have layout so the
 * agent sees the full picture at a glance and can ask for one or several
 * missing fields in a single message (the form extracts and saves each).
 *
 * ## Context Output
 *
 * - `data`: Full FormContextState (programmatic access; e.g. restore action uses nextField)
 * - `values`: String values for template substitution (formContext, formProgress, etc.)
 * - `text`: Human-readable summary injected into the agent prompt
 *
 * ## How It Works
 *
 * ```
 * User Message → Provider Runs → Agent Gets Context → Agent Responds
 *                    ↓
 *              FormContextState
 *                    ↓
 *              - hasActiveForm, progress
 *              - required/optional × have/don't have
 *              - uncertainFields, pendingExternalFields
 *              - single Instruction line
 * ```
 *
 * ## Stashed Forms
 *
 * If the user has stashed forms, the provider appends a reminder so the
 * agent can tell the user they have unfinished work and can say "resume".
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
import type { FormService } from "../service";
import { buildTemplateValues, renderTemplate, resolveControlTemplates } from "../template";
import type { FormContextState } from "../types";

/**
 * Form Context Provider
 *
 * Injects the current form state into the agent's context,
 * allowing the agent to respond naturally about form progress
 * and nudge for missing fields (one or several at once).
 *
 * WHY a provider (not evaluator):
 * - Providers run BEFORE response generation
 * - Agent needs context to generate appropriate response
 * - Evaluator runs AFTER, too late for response
 */
export const formContextProvider: Provider = {
  name: "FORM_CONTEXT",
  description: "Provides context about active form sessions",
  descriptionCompressed: "Active form session context.",

  /**
   * Get form context for the current message.
   *
   * @param runtime - Agent runtime for service access
   * @param message - The user message being processed
   * @param _state - Current agent state (unused)
   * @returns Provider result with form context (data, values, text)
   */
  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      // Get form service
      // WHY type cast: Runtime returns unknown, we know it's FormService
      const formService = runtime.getService("FORM") as FormService;
      if (!formService) {
        // WHY early return: No form plugin registered or FORM service not available
        return { data: { hasActiveForm: false }, values: { formContext: "" }, text: "" };
      }

      // Get entity and room IDs
      // WHY UUID cast: Memory has these as unknown, we need proper typing for storage lookups
      const entityId = message.entityId as UUID;
      const roomId = message.roomId as UUID;
      if (!entityId || !roomId) {
        // WHY early return: Cannot look up session without identity and room
        return { data: { hasActiveForm: false }, values: { formContext: "" }, text: "" };
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

      let contextText = "";
      let contextState: FormContextState;

      if (session) {
        // Build context for active session
        // Get session context from service
        // WHY: Service computes filledFields, missingRequired, uncertainFields, nextField from session + form definition
        contextState = formService.getSessionContext(session);
        const form = formService.getForm(session.formId);
        // Build template values from session (for {{placeholders}} in labels, askPrompt, etc.)
        const templateValues = buildTemplateValues(session);
        // WHY resolve: Form definitions may use {{variable}} in label, description, askPrompt; renderTemplate substitutes from session
        const resolve = (v?: string): string | undefined => renderTemplate(v, templateValues);

        // Apply template resolution to all user-facing strings
        // WHY: Agent and user see resolved labels (e.g. "{{discoveryQuestion1Text}}" → actual question text)
        contextState = {
          ...contextState,
          filledFields: contextState.filledFields.map((f) => ({
            ...f,
            label: resolve(f.label) ?? f.label,
          })),
          missingRequired: contextState.missingRequired.map((f) => ({
            ...f,
            label: resolve(f.label) ?? f.label,
            description: resolve(f.description),
            askPrompt: resolve(f.askPrompt),
          })),
          uncertainFields: contextState.uncertainFields.map((f) => ({
            ...f,
            label: resolve(f.label) ?? f.label,
          })),
          nextField: contextState.nextField
            ? resolveControlTemplates(contextState.nextField, templateValues)
            : null,
        };
        // WHY nextField in data: Restore action reads contextState.nextField for "Let's continue with X"

        // Partition controls into required/optional × filled/missing
        // WHY four buckets: Agent needs full picture at a glance; can nudge for required and optionally for optional; can ask for one or bundle several
        const controls = form?.controls ?? [];
        const filledKeys = new Set(contextState.filledFields.map((f) => f.key));
        const controlByKey = new Map(controls.map((c) => [c.key, c]));

        const requiredFilled = contextState.filledFields.filter(
          (f) => controlByKey.get(f.key)?.required
        );
        const optionalFilled = contextState.filledFields.filter(
          (f) => !controlByKey.get(f.key)?.required
        );
        const optionalMissing = controls.filter(
          (c) => !c.hidden && !c.required && !filledKeys.has(c.key)
        );

        // Format field list as "key (displayValue)" or "key" for missing; "none" when empty
        // WHY key (displayValue): Agent can reference both field name and what we have in conversation
        const fmt = (items: { key: string; displayValue?: string }[]): string =>
          items.length === 0
            ? "none"
            : items
                .map((i) => (i.displayValue ? `${i.key} (${i.displayValue})` : i.key))
                .join(", ");

        // Build human-readable context for agent
        // WHY markdown-style headers: Agent can parse and use structure
        contextText = `# Active Form: ${form?.name || session.formId}\n`;
        // Progress indicator (0–100%, required-fields basis)
        contextText += `Progress: ${contextState.progress}%\n\n`;

        // Required fields we don't have — what we still need
        // WHY show: Agent knows what to ask for; can ask one or bundle several in one message
        contextText += `Required fields we don't have: ${fmt(contextState.missingRequired)}\n`;
        // Required fields we do have — what we already collected
        // WHY show: Agent can reference in conversation ("I have your name as X...")
        contextText += `Required fields we do have: ${fmt(requiredFilled)}\n\n`;
        // Optional fields we don't have
        contextText += `Optional fields we don't have: ${fmt(optionalMissing)}\n`;
        // Optional fields we do have
        contextText += `Optional fields we do have: ${fmt(optionalFilled)}\n\n`;

        // Uncertain fields needing confirmation
        // WHY show uncertain: Agent should ask user to confirm before we commit low-confidence extractions
        if (contextState.uncertainFields.length > 0) {
          contextText += `Needs confirmation:\n`;
          for (const f of contextState.uncertainFields) {
            contextText += `- ${f.label}: "${f.value}" (${Math.round(f.confidence * 100)}% confident)\n`;
          }
          contextText += "\n";
        }

        // Pending external fields (payments, signatures, etc.)
        // WHY show pending: Agent should remind user of outstanding actions and optionally show address
        if (contextState.pendingExternalFields.length > 0) {
          contextText += `Waiting for external action:\n`;
          for (const f of contextState.pendingExternalFields) {
            const mins = Math.floor((Date.now() - f.activatedAt) / 60000);
            contextText += `- ${f.label}: ${f.instructions} (${mins < 1 ? "just now" : `${mins}m ago`})`;
            if (f.address) contextText += ` Address: ${f.address}`;
            contextText += "\n";
          }
          contextText += "\n";
        }

        // Explicit agent guidance — single instruction block
        // WHY one instruction: Avoids conflicting guidance (e.g. "ask next" vs "confirm"); priority order matches UX
        if (contextState.pendingExternalFields.length > 0) {
          // We're waiting for external confirmation (payment, signature, etc.)
          const p = contextState.pendingExternalFields[0];
          contextText += `Instruction: Waiting for external action. Remind user: "${p.instructions}"\n`;
        } else if (contextState.pendingCancelConfirmation) {
          // User wants to cancel a high-effort form; confirm before losing progress
          contextText += `Instruction: User is trying to cancel. Confirm they really want to lose progress.\n`;
        } else if (contextState.uncertainFields.length > 0) {
          // Need to confirm an uncertain value before we commit it
          const u = contextState.uncertainFields[0];
          contextText += `Instruction: Ask user to confirm "${u.label}" = "${u.value}".\n`;
        } else if (contextState.missingRequired.length > 0) {
          // Nudge for required; user can give one or several answers in one message
          contextText += `Instruction: Please nudge the user into helping complete required fields. The user can provide one or several answers in a single message; the form accepts them all.\n`;
        } else if (contextState.status === "ready") {
          // All required fields done; suggest submit
          contextText += `Instruction: All required fields collected. Nudge user to submit.\n`;
        } else if (optionalMissing.length > 0) {
          // Required done; optionally nudge for optional or submit
          contextText += `Instruction: Required fields are done. Optionally nudge for remaining optional fields, or nudge to submit.\n`;
        }
      } else {
        // No active session — only stashed forms exist
        // WHY build contextState anyway: Return shape is consistent; callers get hasActiveForm: false, stashedCount; stashed list goes in text below
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
      // WHY: User might have forgotten about saved forms; agent can say "You have a saved form, say resume to continue"
      if (stashed.length > 0) {
        contextText += `\nSaved forms: User has ${stashed.length} saved form(s). They can say "resume" to restore one.\n`;
        for (const s of stashed) {
          const f = formService.getForm(s.formId);
          const ctx = formService.getSessionContext(s);
          contextText += `- ${f?.name || s.formId} (${ctx.progress}% complete)\n`;
        }
      }

      return {
        // Full context object for programmatic access
        // WHY: Restore action and others read data.nextField, data.filledFields, etc.
        data: JSON.parse(JSON.stringify(contextState)) as Record<string, JsonValue>,
        // String values for template substitution (e.g. in prompts: formContext, formProgress, formStatus)
        values: {
          formContext: contextText,
          hasActiveForm: String(contextState.hasActiveForm),
          formProgress: String(contextState.progress),
          formStatus: contextState.status || "",
          stashedCount: String(stashed.length),
        },
        // Human-readable text for agent (injected into prompt)
        text: contextText,
      };
    } catch (error) {
      logger.error("[FormContextProvider] Error:", String(error));
      // WHY return safe fallback: Provider failure should not break response generation; agent gets empty form context
      return {
        data: { hasActiveForm: false, error: true },
        values: { formContext: "Error loading form context." },
        text: "Error loading form context.",
      };
    }
  },
};

export default formContextProvider;
