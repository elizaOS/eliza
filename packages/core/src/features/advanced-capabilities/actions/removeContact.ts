import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
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
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";

// Get text content from centralized specs
const spec = requireActionSpec("REMOVE_CONTACT");
const REMOVE_CONTACT_TERMS = getValidationKeywordTerms(
	"action.removeContact.request",
	{
		includeAllLocales: true,
	},
);

interface RemoveContactInput {
	contactName?: string;
	confirmed?: boolean;
}

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "yes", "y"].includes(normalized)) return true;
		if (["false", "no", "n"].includes(normalized)) return false;
	}
	return undefined;
}

function readRemoveContactInput(
	message: Memory,
	options?: HandlerOptions,
): RemoveContactInput {
	const params = readParams(options);
	return {
		contactName: readString(params.contactName ?? message.content.contactName),
		confirmed: readBoolean(params.confirmed ?? message.content.confirmed),
	};
}

export const removeContactAction: Action = {
	name: spec.name,
	contexts: ["contacts", "messaging", "documents"],
	roleGate: { minRole: "ADMIN" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	suppressPostActionContinuation: true,
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const hasService = !!runtime.getService("relationships");
		const params = readRemoveContactInput(message, options);
		if (hasService && params.contactName) return true;
		if (
			hasService &&
			hasActionContextOrKeyword(message, state, {
				contexts: ["contacts", "messaging", "documents"],
				keywordKeys: ["action.removeContact.request"],
			})
		) {
			return true;
		}
		const text = message.content.text;
		if (!text) return false;
		const hasIntent = findKeywordTermMatch(text, REMOVE_CONTACT_TERMS);
		return hasService && !!hasIntent;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			const relationshipsService = runtime.getService(
				"relationships",
			) as RelationshipsService;
			if (!relationshipsService) {
				throw new Error("RelationshipsService not available");
			}

			const parsed = readRemoveContactInput(message, _options);

			if (!parsed?.contactName) {
				logger.warn("[RemoveContact] No contact name provided");
				await callback?.({
					text: "I couldn't determine which contact to remove. Please specify the contact name.",
				});
				return {
					success: false,
					text: "I couldn't determine which contact to remove. Please specify the contact name.",
					data: { actionName: "REMOVE_CONTACT" },
				};
			}

			if (parsed.confirmed !== true) {
				await callback?.({
					text: `To remove ${parsed.contactName} from your contacts, please confirm by saying "yes, remove ${parsed.contactName}".`,
				});
				return {
					success: false,
					text: `To remove ${parsed.contactName} from your contacts, please confirm by saying "yes, remove ${parsed.contactName}".`,
					data: { actionName: "REMOVE_CONTACT", confirmationRequired: true },
				};
			}

			const contacts = await relationshipsService.searchContacts({
				searchTerm: parsed.contactName,
			});

			if (contacts.length === 0) {
				await callback?.({
					text: `I couldn't find a contact named "${parsed.contactName}" in the relationships.`,
				});
				return {
					success: false,
					text: `I couldn't find a contact named "${parsed.contactName}" in the relationships.`,
					data: { actionName: "REMOVE_CONTACT" },
				};
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
					data: { actionName: "REMOVE_CONTACT", success: true },
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
			return {
				success: false,
				text: "I encountered an error while removing the contact. Please try again.",
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "REMOVE_CONTACT" },
			};
		}
	},
	parameters: [
		{
			name: "contactName",
			description: "Name of the contact to remove.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "confirmed",
			description:
				"Whether the user explicitly confirmed removal of this contact.",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},
	],
};
