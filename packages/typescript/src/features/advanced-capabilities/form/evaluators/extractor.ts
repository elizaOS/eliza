/**
 * @module evaluators/extractor
 * @description Form evaluator for field extraction and intent handling
 *
 * The evaluator is the "brain" of the form plugin. It runs AFTER
 * each user message to detect intent, extract fields, update state,
 * trigger lifecycle transitions, and emit events.
 */

import type {
	ActionResult,
	Evaluator,
	EventPayload,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
	UUID,
} from "../../../../types/index.ts";
import { logger } from "../../../../types/index.ts";
import { llmIntentAndExtract } from "../extraction.ts";
import { quickIntentDetect } from "../intent.ts";
import type { FormService } from "../service.ts";
import { buildTemplateValues } from "../template.ts";
import type {
	ExtractionResult,
	FormDefinition,
	FormIntent,
	FormSession,
} from "../types.ts";

export const formEvaluator: Evaluator = {
	name: "form_evaluator",
	description:
		"Extracts form fields and handles form intents from user messages",
	similes: ["FORM_EXTRACTION", "FORM_HANDLER"],
	examples: [],

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

			const session = await formService.getActiveSession(entityId, roomId);
			const stashed = await formService.getStashedSessions(entityId);

			return session !== null || stashed.length > 0;
		} catch (error) {
			logger.error("[FormEvaluator] Validation error:", String(error));
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ActionResult | undefined> => {
		try {
			const formService = runtime.getService("FORM") as FormService;
			if (!formService) return undefined;

			const entityId = message.entityId as UUID;
			const roomId = message.roomId as UUID;
			const text = message.content?.text || "";

			if (!entityId || !roomId) return undefined;

			if (!text.trim()) return undefined;

			let session = await formService.getActiveSession(entityId, roomId);

			// === TIER 1: Fast Path Intent Detection ===
			let intent: FormIntent | null = quickIntentDetect(text);
			let extractions: ExtractionResult[] = [];

			// Handle restore intent when no active session
			if (intent === "restore" && !session) {
				logger.debug(
					"[FormEvaluator] Restore intent detected, deferring to action",
				);
				return undefined;
			}

			if (!session) {
				return undefined;
			}

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
			switch (intent) {
				case "submit":
					await handleSubmit(formService, session, entityId);
					break;

				case "stash":
					await formService.stash(session.id, entityId);
					break;

				case "cancel":
					await formService.cancel(session.id, entityId);
					break;

				case "undo":
					await handleUndo(formService, session, entityId, form);
					break;

				case "skip":
					await handleSkip(formService, session, entityId, form);
					break;

				case "autofill":
					await formService.applyAutofill(session);
					break;

				case "explain":
				case "example":
				case "progress":
					logger.debug(`[FormEvaluator] Info intent: ${intent}`);
					break;

				case "restore":
					logger.debug("[FormEvaluator] Restore intent - deferring to action");
					break;

				default:
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

async function processExtractions(
	runtime: IAgentRuntime,
	formService: FormService,
	session: FormSession,
	form: FormDefinition,
	entityId: UUID,
	extractions: ExtractionResult[],
	messageId?: string,
): Promise<void> {
	const updatedParents: Set<string> = new Set();

	for (const extraction of extractions) {
		if (extraction.field.includes(".")) {
			const [parentKey, subKey] = extraction.field.split(".");

			await formService.updateSubField(
				session.id,
				entityId,
				parentKey,
				subKey,
				extraction.value,
				extraction.confidence,
				messageId,
			);

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
			await formService.updateField(
				session.id,
				entityId,
				extraction.field,
				extraction.value,
				extraction.confidence,
				extraction.isCorrection ? "correction" : "extraction",
				messageId,
			);

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

async function checkAndActivateExternalField(
	runtime: IAgentRuntime,
	formService: FormService,
	session: FormSession,
	form: FormDefinition,
	entityId: UUID,
	field: string,
): Promise<void> {
	const freshSession = await formService.getActiveSession(
		entityId,
		session.roomId,
	);
	if (!freshSession) return;

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

	const subValues = formService.getSubFieldValues(freshSession, field);

	await emitEvent(runtime, "FORM_SUBCONTROLS_FILLED", {
		sessionId: session.id,
		field,
		subValues,
	});

	logger.debug(
		`[FormEvaluator] All subcontrols filled for ${field}, activating...`,
	);

	try {
		const activation = await formService.activateExternalField(
			session.id,
			entityId,
			field,
		);
		const activationPayload = JSON.parse(
			JSON.stringify(activation),
		) as JsonValue;

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
		logger.debug(
			`[FormEvaluator] Event emission (${eventType}):`,
			String(error),
		);
	}
}

// ============================================================================
// INTENT HANDLERS
// ============================================================================

async function handleSubmit(
	formService: FormService,
	session: { id: string; status: string },
	entityId: UUID,
): Promise<void> {
	try {
		await formService.submit(session.id, entityId);
	} catch (error) {
		logger.debug("[FormEvaluator] Submit failed:", String(error));
	}
}

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

async function handleSkip(
	formService: FormService,
	session: { id: string; lastAskedField?: string },
	entityId: UUID,
	form: { ux?: { allowSkip?: boolean } },
): Promise<void> {
	if (!form.ux?.allowSkip) {
		return;
	}

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
