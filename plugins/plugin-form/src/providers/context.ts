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
import {
  buildTemplateValues,
  renderTemplate,
  resolveControlTemplates,
} from "../template";
import type { FormContextState } from "../types";

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const MAX_CONTEXT_FIELDS = 20;
const MAX_STASHED_FOR_CONTEXT = 10;

/**
 * Form Context Provider
 *
 * Injects the current form state into the agent's context,
 * allowing the agent to respond naturally about form progress
 * and nudge for missing fields (one or several at once).
 */
export const formContextProvider: Provider = {
  name: "FORM_CONTEXT",
  description: "Provides context about active form sessions",
  descriptionCompressed: "Active form session context.",
  contexts: ["automation", "knowledge"],
  contextGate: { anyOf: ["automation", "knowledge"] },
  cacheStable: false,
  cacheScope: "turn",

  /**
   * Get form context for the current message.
   *
   * @param runtime - Agent runtime for service access
   * @param message - The user message being processed
   * @param _state - Current agent state (unused)
   * @returns Provider result with form context (data, values, text)
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
        // WHY early return: No form plugin registered or FORM service not available
        return {
          data: { hasActiveForm: false },
          values: { formContext: "" },
          text: "",
        };
      }

      // Get entity and room IDs
      // WHY UUID cast: Memory has these as unknown, we need proper typing for storage lookups
      const entityId = message.entityId as UUID;
      const roomId = message.roomId as UUID;
      if (!entityId || !roomId) {
        // WHY early return: Cannot look up session without identity and room
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

      let contextText = "";
      let contextState: FormContextState;
      let stashedRows: Array<Record<string, unknown>> = [];

      if (session) {
        // Build context for active session
        // Get session context from service
        // WHY: Service computes filledFields, missingRequired, uncertainFields, nextField from session + form definition
        contextState = formService.getSessionContext(session);
        const form = formService.getForm(session.formId);
        // Build template values from session (for {{placeholders}} in labels, askPrompt, etc.)
        const templateValues = buildTemplateValues(session);
        // WHY resolve: Form definitions may use {{variable}} in label, description, askPrompt; renderTemplate substitutes from session
        const resolve = (v?: string): string | undefined =>
          renderTemplate(v, templateValues);

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
          (f) => controlByKey.get(f.key)?.required,
        );
        const optionalFilled = contextState.filledFields.filter(
          (f) => !controlByKey.get(f.key)?.required,
        );
        const optionalMissing = controls
          .filter((c) => !c.hidden && !c.required && !filledKeys.has(c.key))
          .map((c) => resolveControlTemplates(c, templateValues));

        let instruction = "";
        // Explicit agent guidance — single instruction field
        // WHY one instruction: Avoids conflicting guidance (e.g. "ask next" vs "confirm"); priority order matches UX
        if (contextState.pendingExternalFields.length > 0) {
          // We're waiting for external confirmation (payment, signature, etc.)
          const p = contextState.pendingExternalFields[0];
          instruction = `Waiting for external action. Remind user: "${p.instructions}"`;
        } else if (contextState.pendingCancelConfirmation) {
          // User wants to cancel a high-effort form; confirm before losing progress
          instruction =
            "User is trying to cancel. Confirm they really want to lose progress.";
        } else if (contextState.uncertainFields.length > 0) {
          // Need to confirm an uncertain value before we commit it
          const u = contextState.uncertainFields[0];
          instruction = `Ask user to confirm "${u.label}" = "${u.value}".`;
        } else if (contextState.missingRequired.length > 0) {
          // Nudge for required; user can give one or several answers in one message
          instruction =
            "Nudge the user into helping complete required fields. The user can provide one or several answers in a single message.";
        } else if (contextState.status === "ready") {
          // All required fields done; suggest submit
          instruction = "All required fields collected. Nudge user to submit.";
        } else if (optionalMissing.length > 0) {
          // Required done; optionally nudge for optional or submit
          instruction =
            "Required fields are done. Optionally nudge for remaining optional fields, or nudge to submit.";
        }

        contextText = `form_context_json:\n${compactJson({
          active: true,
          form_id: session.formId,
          form_name: form?.name || session.formId,
          progress: contextState.progress,
          status: contextState.status,
          required_missing: contextState.missingRequired.slice(
            0,
            MAX_CONTEXT_FIELDS,
          ),
          required_filled: requiredFilled.map((field) => ({
            ...field,
            value: field.displayValue,
          })).slice(0, MAX_CONTEXT_FIELDS),
          optional_missing: optionalMissing.slice(0, MAX_CONTEXT_FIELDS),
          optional_filled: optionalFilled.map((field) => ({
            ...field,
            value: field.displayValue,
          })).slice(0, MAX_CONTEXT_FIELDS),
          uncertain_fields: contextState.uncertainFields
            .slice(0, MAX_CONTEXT_FIELDS)
            .map((field) => ({
              ...field,
              confidence: Math.round(field.confidence * 100) / 100,
            })),
          pending_external_fields: contextState.pendingExternalFields.map(
            (field) => ({
              ...field,
              age_minutes: Math.max(
                0,
                Math.floor((Date.now() - field.activatedAt) / 60000),
              ),
            }),
          ).slice(0, MAX_CONTEXT_FIELDS),
          instruction,
        })}`;
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
        contextText = `form_context_json:\n${compactJson({
          active: false,
          progress: 0,
          stashed_count: stashed.length,
        })}`;
      }

      // Stashed forms reminder
      // WHY: User might have forgotten about saved forms; agent can say "You have a saved form, say resume to continue"
      if (stashed.length > 0) {
        stashedRows = stashed.slice(0, MAX_STASHED_FOR_CONTEXT).map((s) => {
          const f = formService.getForm(s.formId);
          const ctx = formService.getSessionContext(s);
          return {
            form_id: s.formId,
            form_name: f?.name || s.formId,
            progress: ctx.progress,
          };
        });
        contextText += `\nstashed_forms_json:\n${compactJson(stashedRows)}`;
        contextText +=
          "\nstashed_instruction: User can say resume to restore one.";
      }

      return {
        // Full context object for programmatic access
        // WHY: Restore action and others read data.nextField, data.filledFields, etc.
        data: JSON.parse(JSON.stringify(contextState)) as Record<
          string,
          JsonValue
        >,
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
        values: { formContext: 'form_context_json:\n{"error":true}' },
        text: 'form_context_json:\n{"error":true}',
      };
    }
  },
};

export default formContextProvider;
