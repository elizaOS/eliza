/**
 * @module providers/context
 * @description Form context provider for agent awareness
 *
 * This provider injects form state into the agent's context BEFORE
 * the agent generates a response.
 */

import type {
	IAgentRuntime,
	JsonValue,
	Memory,
	Provider,
	ProviderResult,
	State,
	UUID,
} from "../../../../types/index.ts";
import { logger } from "../../../../types/index.ts";
import type { FormService } from "../service.ts";
import {
	buildTemplateValues,
	renderTemplate,
	resolveControlTemplates,
} from "../template.ts";
import type { FormContextState } from "../types.ts";

export const formContextProvider: Provider = {
	name: "FORM_CONTEXT",
	description: "Provides context about active form sessions",

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const formService = runtime.getService("FORM") as FormService;
			if (!formService) {
				return {
					data: { hasActiveForm: false },
					values: { formContext: "" },
					text: "",
				};
			}

			const entityId = message.entityId as UUID;
			const roomId = message.roomId as UUID;
			if (!entityId || !roomId) {
				return {
					data: { hasActiveForm: false },
					values: { formContext: "" },
					text: "",
				};
			}

			const session = await formService.getActiveSession(entityId, roomId);
			const stashed = await formService.getStashedSessions(entityId);

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
				contextState = formService.getSessionContext(session);
				const form = formService.getForm(session.formId);
				const templateValues = buildTemplateValues(session);
				const resolve = (v?: string): string | undefined =>
					renderTemplate(v, templateValues);

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

				const controls = form?.controls ?? [];
				const filledKeys = new Set(contextState.filledFields.map((f) => f.key));
				const controlByKey = new Map(controls.map((c) => [c.key, c]));

				const requiredFilled = contextState.filledFields.filter(
					(f) => controlByKey.get(f.key)?.required,
				);
				const optionalFilled = contextState.filledFields.filter(
					(f) => !controlByKey.get(f.key)?.required,
				);
				const optionalMissing = controls.filter(
					(c) => !c.hidden && !c.required && !filledKeys.has(c.key),
				);

				const fmt = (
					items: { key: string; displayValue?: string }[],
				): string =>
					items.length === 0
						? "none"
						: items
								.map((i) =>
									i.displayValue ? `${i.key} (${i.displayValue})` : i.key,
								)
								.join(", ");

				contextText = `# Active Form: ${form?.name || session.formId}\n`;
				contextText += `Progress: ${contextState.progress}%\n\n`;

				contextText += `Required fields we don't have: ${fmt(contextState.missingRequired)}\n`;
				contextText += `Required fields we do have: ${fmt(requiredFilled)}\n\n`;
				contextText += `Optional fields we don't have: ${fmt(optionalMissing)}\n`;
				contextText += `Optional fields we do have: ${fmt(optionalFilled)}\n\n`;

				if (contextState.uncertainFields.length > 0) {
					contextText += `Needs confirmation:\n`;
					for (const f of contextState.uncertainFields) {
						contextText += `- ${f.label}: "${f.value}" (${Math.round(f.confidence * 100)}% confident)\n`;
					}
					contextText += "\n";
				}

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

				if (contextState.pendingExternalFields.length > 0) {
					const p = contextState.pendingExternalFields[0];
					contextText += `Instruction: Waiting for external action. Remind user: "${p.instructions}"\n`;
				} else if (contextState.pendingCancelConfirmation) {
					contextText += `Instruction: User is trying to cancel. Confirm they really want to lose progress.\n`;
				} else if (contextState.uncertainFields.length > 0) {
					const u = contextState.uncertainFields[0];
					contextText += `Instruction: Ask user to confirm "${u.label}" = "${u.value}".\n`;
				} else if (contextState.missingRequired.length > 0) {
					contextText += `Instruction: Please nudge the user into helping complete required fields. The user can provide one or several answers in a single message; the form accepts them all.\n`;
				} else if (contextState.status === "ready") {
					contextText += `Instruction: All required fields collected. Nudge user to submit.\n`;
				} else if (optionalMissing.length > 0) {
					contextText += `Instruction: Required fields are done. Optionally nudge for remaining optional fields, or nudge to submit.\n`;
				}
			} else {
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

			if (stashed.length > 0) {
				contextText += `\nSaved forms: User has ${stashed.length} saved form(s). They can say "resume" to restore one.\n`;
				for (const s of stashed) {
					const f = formService.getForm(s.formId);
					const ctx = formService.getSessionContext(s);
					contextText += `- ${f?.name || s.formId} (${ctx.progress}% complete)\n`;
				}
			}

			return {
				data: JSON.parse(JSON.stringify(contextState)) as Record<
					string,
					JsonValue
				>,
				values: {
					formContext: contextText,
					hasActiveForm: String(contextState.hasActiveForm),
					formProgress: String(contextState.progress),
					formStatus: contextState.status || "",
					stashedCount: String(stashed.length),
				},
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
