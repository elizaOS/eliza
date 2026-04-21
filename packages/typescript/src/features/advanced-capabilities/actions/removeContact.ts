import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import { removeContactTemplate } from "../../../prompts.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("REMOVE_CONTACT");
const REMOVE_CONTACT_TERMS = getValidationKeywordTerms(
	"action.removeContact.request",
	{
		includeAllLocales: true,
	},
);

interface RemoveContactXmlResult {
	contactName?: string;
	confirmed?: string;
}

export const removeContactAction: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		const hasService = !!runtime.getService("relationships");
		const text = message.content.text;
		if (!text) return false;
		const hasIntent = findKeywordTermMatch(text, REMOVE_CONTACT_TERMS);
		return hasService && !!hasIntent;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult | undefined> => {
		try {
			const relationshipsService = runtime.getService(
				"relationships",
			) as RelationshipsService;
			if (!relationshipsService) {
				throw new Error("RelationshipsService not available");
			}

			// Build state for prompt composition
			const removeState: State = {
				values: {
					...state?.values,
					message: message.content.text,
					senderName: state?.values?.senderName || "User",
					senderId: message.entityId,
				},
				data: state?.data || {},
				text: state?.text || "",
			};

			const prompt = composePromptFromState({
				state: removeState,
				template: removeContactTemplate,
			});

			const response = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt,
				stopSequences: [],
			});
			const parsed = parseKeyValueXml<RemoveContactXmlResult>(response);

			if (!parsed?.contactName) {
				logger.warn("[RemoveContact] No contact name provided");
				await callback?.({
					text: "I couldn't determine which contact to remove. Please specify the contact name.",
				});
				return;
			}

			const confirmed = parsed.confirmed?.trim().toLowerCase();
			if (confirmed !== "yes") {
				await callback?.({
					text: `To remove ${parsed.contactName} from your contacts, please confirm by saying "yes, remove ${parsed.contactName}".`,
				});
				return;
			}

			const contacts = await relationshipsService.searchContacts({
				searchTerm: parsed.contactName,
			});

			if (contacts.length === 0) {
				await callback?.({
					text: `I couldn't find a contact named "${parsed.contactName}" in the relationships.`,
				});
				return;
			}

			const contact = contacts[0];

			const removed = await relationshipsService.removeContact(
				contact.entityId,
			);

			if (removed) {
				const responseText = `I've removed ${parsed.contactName} from your contacts.`;
				await callback?.({
					text: responseText,
					actions: ["REMOVE_CONTACT"],
				});

				logger.info(`[RemoveContact] Removed contact ${contact.entityId}`);

				return {
					success: true,
					values: { contactId: contact.entityId },
					data: { success: true },
					text: responseText,
				};
			} else {
				throw new Error("Failed to remove contact");
			}
		} catch (error) {
			logger.error(
				"[RemoveContact] Error:",
				error instanceof Error ? error.message : String(error),
			);
			await callback?.({
				text: "I encountered an error while removing the contact. Please try again.",
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	},
};
