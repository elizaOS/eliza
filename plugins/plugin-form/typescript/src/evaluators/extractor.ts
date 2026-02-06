/**
 * @module evaluators/extractor
 * @description Form evaluator for field extraction and intent handling
 *
 * ## Role in Form Plugin
 *
 * The evaluator is the "brain" of the form plugin. It runs AFTER
 * each user message and:
 *
 * 1. Detects user intent (submit, cancel, undo, etc.)
 * 2. Extracts field values from natural language
 * 3. Updates session state accordingly
 * 4. Triggers lifecycle transitions
 * 5. **Emits events** for widgets and other listeners
 *
 * ## Event Emission
 *
 * The evaluator emits standardized events as it processes messages:
 *
 * - `FORM_FIELD_EXTRACTED`: Value extracted for a simple field
 * - `FORM_SUBFIELD_UPDATED`: Value extracted for a composite subfield
 * - `FORM_SUBCONTROLS_FILLED`: All subcontrols of composite type filled
 * - `FORM_EXTERNAL_ACTIVATED`: External type activated
 *
 * Widgets DON'T parse messages - they react to these events.
 * This keeps parsing logic centralized in the evaluator.
 *
 * ## Processing Flow
 *
 * ```
 * User Message → Evaluator.validate() → Should we run?
 *                        ↓ Yes
 *              Evaluator.handler() →
 *                        ↓
 *              quickIntentDetect() → Fast path for English
 *                        ↓ No match
 *              llmIntentAndExtract() → LLM fallback
 *                        ↓
 *              Handle intent (submit, stash, cancel, undo, etc.)
 *                        ↓
 *              Process extractions (update fields OR subfields)
 *                        ↓
 *              Emit events (FORM_FIELD_EXTRACTED, etc.)
 *                        ↓
 *              Check composite types → Activate if all subfields filled
 *                        ↓
 *              Save session
 * ```
 *
 * ## Why Evaluator (Not Action)
 *
 * We use an evaluator because:
 *
 * 1. **Runs Always**: Evaluators run on every message, not just when
 *    explicitly invoked. Form extraction should happen automatically.
 *
 * 2. **Post-Processing**: Evaluators run after actions, allowing the
 *    provider to set context and REPLY action to generate response.
 *
 * 3. **No Response Generation**: Evaluators don't generate responses,
 *    they just update state. The agent (REPLY) handles responses.
 *
 * ## Intent Handling
 *
 * Different intents are handled differently:
 *
 * - **Lifecycle** (submit, stash, cancel): Change session status
 * - **UX** (undo, skip, autofill): Modify session without status change
 * - **Info** (explain, example, progress): No state change, just context
 * - **Data** (fill_form): Extract and update field values
 *
 * ## FORM_RESTORE Exception
 *
 * The 'restore' intent is handled by FORM_RESTORE action, not here.
 * This is because restore needs to happen BEFORE the provider runs,
 * so the agent has the restored form context for its response.
 */

import type {
  ActionResult,
  EventPayload,
  Evaluator,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { FormService } from "../service";
import { quickIntentDetect } from "../intent";
import { llmIntentAndExtract } from "../extraction";
import { buildTemplateValues } from "../template";
import type {
  FormIntent,
  ExtractionResult,
  FormSession,
  FormDefinition,
} from "../types";

/**
 * Form Evaluator
 *
 * Runs after each message to:
 * 1. Detect user intent (fast path for English, LLM fallback for other languages)
 * 2. Extract field values from natural language
 * 3. Handle lifecycle intents (submit, stash, cancel)
 * 4. Handle UX intents (undo, skip, explain, example, progress, autofill)
 * 5. Update session state
 */
export const formEvaluator: Evaluator = {
  name: "form_evaluator",
  description:
    "Extracts form fields and handles form intents from user messages",
  similes: ["FORM_EXTRACTION", "FORM_HANDLER"],
  examples: [], // No examples needed for evaluators

  /**
   * Validate: Should this evaluator run?
   *
   * Only runs if there's an active form session OR stashed sessions
   * (to handle restore intent).
   *
   * WHY check stashed:
   * - User might say "resume my form"
   * - Need to detect restore intent even without active session
   * - Note: Actual restore is handled by FORM_RESTORE action
   *
   * @returns true if evaluator should run
   */
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    try {
      const formService = runtime.getService("FORM") as FormService;
      if (!formService) return false;

      const entityId = message.entityId as UUID;
      const roomId = message.roomId as UUID;

      if (!entityId || !roomId) return false;

      // Run if there's an active session OR if there are stashed sessions
      // (to handle restore intent)
      const session = await formService.getActiveSession(entityId, roomId);
      const stashed = await formService.getStashedSessions(entityId);

      return session !== null || stashed.length > 0;
    } catch (error) {
      logger.error("[FormEvaluator] Validation error:", String(error));
      return false;
    }
  },

  /**
   * Handler: Process the message and update form state.
   *
   * This is the main logic loop:
   * 1. Try fast-path intent detection
   * 2. Fall back to LLM if no match
   * 3. Handle the detected intent
   * 4. Process any field extractions
   *
   * @param runtime - Agent runtime for service access
   * @param message - The user message to process
   * @param state - Current agent state (optional)
   */
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<ActionResult | undefined> => {
    try {
      const formService = runtime.getService("FORM") as FormService;
      if (!formService) return undefined;

      const entityId = message.entityId as UUID;
      const roomId = message.roomId as UUID;
      const text = message.content?.text || "";

      if (!entityId || !roomId) return undefined;

      // Skip empty messages
      if (!text.trim()) return undefined;

      // Get active session
      let session = await formService.getActiveSession(entityId, roomId);

      // === TIER 1: Fast Path Intent Detection ===
      // Try English keyword matching first (no LLM call)
      let intent: FormIntent | null = quickIntentDetect(text);
      let extractions: ExtractionResult[] = [];

      // Handle restore intent when no active session
      // WHY early return: Restore is handled by FORM_RESTORE action
      if (intent === "restore" && !session) {
        logger.debug(
          "[FormEvaluator] Restore intent detected, deferring to action",
        );
        return undefined;
      }

      // If no active session after restore check, nothing else to do
      if (!session) {
        return undefined;
      }

      // Get the form definition
      const form = formService.getForm(session.formId);
      if (!form) {
        logger.warn(
          "[FormEvaluator] Form not found for session:",
          session.formId,
        );
        return undefined;
      }
      const templateValues = buildTemplateValues(session);

      // === TIER 2: LLM Fallback ===
      // If fast path didn't match, use LLM for:
      // - Non-English phrases
      // - Ambiguous messages
      // - Field extraction
      if (!intent) {
        const result = await llmIntentAndExtract(
          runtime,
          text,
          form,
          form.controls,
          templateValues,
        );
        intent = result.intent;
        extractions = result.extractions;

        if (form.debug) {
          logger.debug(
            "[FormEvaluator] LLM extraction result:",
            JSON.stringify({ intent, extractions }),
          );
        }
      }

      // === INTENT HANDLING ===
      // Different intents require different handling
      switch (intent) {
        // --- Lifecycle Intents ---

        case "submit":
          // User wants to complete the form
          await handleSubmit(formService, session, entityId);
          break;

        case "stash":
          // User wants to save for later
          await formService.stash(session.id, entityId);
          break;

        case "cancel":
          // User wants to abandon the form
          // Note: cancel() handles confirmation for high-effort forms
          await formService.cancel(session.id, entityId);
          break;

        // --- UX Intents ---

        case "undo":
          // Revert the last field change
          await handleUndo(formService, session, entityId, form);
          break;

        case "skip":
          // Skip the current optional field
          await handleSkip(formService, session, entityId, form);
          break;

        case "autofill":
          // Apply saved values from previous submissions
          await formService.applyAutofill(session);
          break;

        // --- Info Intents ---
        // These don't change state - the provider gives context for response

        case "explain":
        case "example":
        case "progress":
          // These are info intents - the provider will give context
          // The agent (REPLY) will respond based on provider context
          // We just log that we got an info request
          logger.debug(`[FormEvaluator] Info intent: ${intent}`);
          break;

        // --- Special Cases ---

        case "restore":
          // Handled by FORM_RESTORE action, should not reach here
          // WHY here: Just in case it does, log and skip
          logger.debug("[FormEvaluator] Restore intent - deferring to action");
          break;

        // --- Data Intents ---

        case "fill_form":
        default:
          // Process extractions - update field values
          // This handles both simple fields and subfields for composite types
          await processExtractions(
            runtime,
            formService,
            session,
            form,
            entityId,
            extractions,
            message.id,
          );
          break;
      }

      // Update last message ID for tracking
      // WHY: Helps with deduplication and debugging
      session = await formService.getActiveSession(entityId, roomId);
      if (session) {
        session.lastMessageId = message.id;
        await formService.saveSession(session);
      }
    } catch (error) {
      logger.error("[FormEvaluator] Handler error:", String(error));
      return undefined;
    }
    return undefined;
  },
};

// ============================================================================
// EXTRACTION PROCESSING
// ============================================================================

/**
 * Process field extractions, handling both simple and composite types.
 *
 * This is the central extraction handler that:
 * 1. Determines if each extraction is for a simple field or subfield
 * 2. Updates the appropriate field/subfield state
 * 3. Emits events for listeners (widgets, analytics)
 * 4. Triggers activation for external types when subcontrols are filled
 *
 * WHY centralized:
 * - Single point of message parsing → event emission
 * - Widgets don't parse, they react to events
 * - Consistent event flow for all field types
 *
 * WHY event emission:
 * - Decouples extraction from widget logic
 * - Widgets can be in separate plugins
 * - Enables analytics/logging without code changes
 * - Reactive pattern: events flow, state changes automatically
 *
 * WHY track updatedParents:
 * - Need to check if composite types are now ready for activation
 * - Only check parents that had subfield updates this turn
 * - Avoids redundant activation checks
 */
async function processExtractions(
  runtime: IAgentRuntime,
  formService: FormService,
  session: FormSession,
  form: FormDefinition,
  entityId: UUID,
  extractions: ExtractionResult[],
  messageId?: string,
): Promise<void> {
  // Track which parent fields had subfields updated (for activation check)
  const updatedParents: Set<string> = new Set();

  for (const extraction of extractions) {
    // Check if this is a subfield (e.g., "payment.amount")
    if (extraction.field.includes(".")) {
      const [parentKey, subKey] = extraction.field.split(".");

      // Update subfield
      await formService.updateSubField(
        session.id,
        entityId,
        parentKey,
        subKey,
        extraction.value,
        extraction.confidence,
        messageId,
      );

      // Emit FORM_SUBFIELD_UPDATED event
      await emitEvent(runtime, "FORM_SUBFIELD_UPDATED", {
        sessionId: session.id,
        parentField: parentKey,
        subField: subKey,
        value: extraction.value,
        confidence: extraction.confidence,
      });

      updatedParents.add(parentKey);

      if (form.debug) {
        logger.debug(`[FormEvaluator] Updated subfield ${parentKey}.${subKey}`);
      }
    } else {
      // Simple field update
      await formService.updateField(
        session.id,
        entityId,
        extraction.field,
        extraction.value,
        extraction.confidence,
        extraction.isCorrection ? "correction" : "extraction",
        messageId,
      );

      // Emit FORM_FIELD_EXTRACTED event
      await emitEvent(runtime, "FORM_FIELD_EXTRACTED", {
        sessionId: session.id,
        field: extraction.field,
        value: extraction.value,
        confidence: extraction.confidence,
      });

      if (form.debug) {
        logger.debug(`[FormEvaluator] Updated field ${extraction.field}`);
      }
    }
  }

  // Check if any parent fields are now ready for activation
  // (all subcontrols filled for composite/external types)
  for (const parentKey of updatedParents) {
    await checkAndActivateExternalField(
      runtime,
      formService,
      session,
      form,
      entityId,
      parentKey,
    );
  }
}

/**
 * Check if a composite field is ready for external activation.
 *
 * Called after subfield updates to see if all subcontrols are now filled.
 * If so, and the type has an activate method, we activate it.
 *
 * WHY automatic activation:
 * - User fills subcontrols naturally ("$50 in SOL")
 * - When all filled, we immediately start the external process
 * - No need for explicit "activate" command
 *
 * WHY refresh session:
 * - Session in memory might be stale after subfield updates
 * - Need latest subfield states for accurate check
 *
 * WHY emit events before AND after activation:
 * - FORM_SUBCONTROLS_FILLED: Widget knows subcontrols ready
 * - FORM_EXTERNAL_ACTIVATED: Widget knows activation succeeded
 * - Allows different handlers for each stage
 *
 * WHY try/catch activation:
 * - External services might fail (network, validation)
 * - Failure shouldn't crash the evaluator
 * - User can retry by providing values again
 */
async function checkAndActivateExternalField(
  runtime: IAgentRuntime,
  formService: FormService,
  session: FormSession,
  form: FormDefinition,
  entityId: UUID,
  field: string,
): Promise<void> {
  // Refresh session to get latest subfield states
  const freshSession = await formService.getActiveSession(
    entityId,
    session.roomId,
  );
  if (!freshSession) return;

  // Check if this is an external type with all subcontrols filled
  if (
    !formService.isExternalType(
      form.controls.find((c) => c.key === field)?.type || "",
    )
  ) {
    return;
  }

  if (!formService.areSubFieldsFilled(freshSession, field)) {
    return;
  }

  // Get subfield values
  const subValues = formService.getSubFieldValues(freshSession, field);

  // Emit FORM_SUBCONTROLS_FILLED event
  await emitEvent(runtime, "FORM_SUBCONTROLS_FILLED", {
    sessionId: session.id,
    field,
    subValues,
  });

  logger.debug(
    `[FormEvaluator] All subcontrols filled for ${field}, activating...`,
  );

  try {
    // Activate the external field
    const activation = await formService.activateExternalField(
      session.id,
      entityId,
      field,
    );
    const activationPayload = JSON.parse(
      JSON.stringify(activation),
    ) as JsonValue;

    // Emit FORM_EXTERNAL_ACTIVATED event
    await emitEvent(runtime, "FORM_EXTERNAL_ACTIVATED", {
      sessionId: session.id,
      field,
      activation: activationPayload,
    });

    logger.info(
      `[FormEvaluator] Activated external field ${field}: ${activation.instructions}`,
    );
  } catch (error) {
    logger.error(
      `[FormEvaluator] Failed to activate external field ${field}:`,
      String(error),
    );
  }
}

/**
 * Emit an event to the runtime.
 *
 * Wraps runtime.emitEvent with error handling since not all runtimes
 * may have event handlers registered.
 *
 * WHY wrap instead of direct call:
 * - runtime.emitEvent might not exist (older runtimes)
 * - No listeners is normal, not an error
 * - Evaluator should keep running regardless
 *
 * WHY debug log on error:
 * - Helps diagnose missing handlers during development
 * - Doesn't spam logs in production (debug level)
 */
async function emitEvent(
  runtime: IAgentRuntime,
  eventType: string,
  payload: Record<string, JsonValue>,
): Promise<void> {
  try {
    if (typeof runtime.emitEvent === "function") {
      const eventPayload: EventPayload = { runtime, ...payload };
      await runtime.emitEvent(eventType, eventPayload);
    }
  } catch (error) {
    // Event handlers might not be registered, that's OK
    logger.debug(
      `[FormEvaluator] Event emission (${eventType}):`,
      String(error),
    );
  }
}

// ============================================================================
// INTENT HANDLERS
// ============================================================================

/**
 * Handle submit intent.
 *
 * Attempts to submit the form. May fail if required fields are missing,
 * in which case the provider will show what's missing.
 *
 * WHY separate function:
 * - Encapsulates error handling
 * - Easy to add logging/analytics
 */
async function handleSubmit(
  formService: FormService,
  session: { id: string; status: string },
  entityId: UUID,
): Promise<void> {
  try {
    await formService.submit(session.id, entityId);
  } catch (error) {
    // Submit may fail if required fields are missing
    // The provider will show what's missing, agent will ask
    logger.debug("[FormEvaluator] Submit failed:", String(error));
  }
}

/**
 * Handle undo intent.
 *
 * Reverts the last field change if undo is allowed.
 *
 * WHY check allowUndo:
 * - Some forms disable undo (legal forms, etc.)
 */
async function handleUndo(
  formService: FormService,
  session: { id: string; lastAskedField?: string },
  entityId: UUID,
  form: { ux?: { allowUndo?: boolean } },
): Promise<void> {
  if (!form.ux?.allowUndo) {
    return;
  }

  const result = await formService.undoLastChange(session.id, entityId);
  if (result) {
    logger.debug("[FormEvaluator] Undid field:", result.field);
  }
}

/**
 * Handle skip intent.
 *
 * Marks the last-asked field as skipped if it's optional.
 *
 * WHY lastAskedField:
 * - "Skip" refers to the current question
 * - We track which field was last asked
 *
 * WHY not skip required:
 * - Required fields can't be skipped
 * - Agent should explain this to user
 */
async function handleSkip(
  formService: FormService,
  session: { id: string; lastAskedField?: string },
  entityId: UUID,
  form: { ux?: { allowSkip?: boolean } },
): Promise<void> {
  if (!form.ux?.allowSkip) {
    return;
  }

  // Skip the last asked field if known
  if (session.lastAskedField) {
    const skipped = await formService.skipField(
      session.id,
      entityId,
      session.lastAskedField,
    );
    if (skipped) {
      logger.debug("[FormEvaluator] Skipped field:", session.lastAskedField);
    }
  }
}

export default formEvaluator;
