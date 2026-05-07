import {
	type Action,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	type State,
} from "../../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
import { createClipboardService } from "../services/clipboardService.ts";
import { requireActionSpec } from "../specs.ts";

interface DeleteInput {
	id: string;
}

function isValidDeleteInput(obj: Record<string, unknown>): boolean {
	return typeof obj.id === "string" && obj.id.length > 0;
}

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function extractDeleteInfo(
	message: Memory,
	options?: HandlerOptions,
): DeleteInput | null {
	const params = readParams(options);
	const raw = {
		id: params.id ?? message.content.id ?? message.content.entryId,
	};

	if (!isValidDeleteInput(raw)) {
		logger.error("[ClipboardDelete] Failed to extract valid delete info");
		return null;
	}

	return {
		id: String(raw.id),
	};
}

const spec = requireActionSpec("CLIPBOARD_DELETE");
const MAX_CONTEXT_ENTRIES = 20;
const MAX_TITLE_CHARS = 120;

function truncateText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const clipboardDeleteAction: Action = {
	name: spec.name,
	contexts: ["files", "knowledge", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const __avParams = readParams(options);
		if (isValidDeleteInput(__avParams)) {
			return true;
		}
		return hasActionContextOrKeyword(message, state, {
			contexts: ["files", "knowledge", "agent_internal"],
			keywords: ["clipboard", "delete", "remove note", "delete note"],
		});
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_stateFromTrigger: State | undefined,
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
		_responses?: Memory[],
	) => {
		const service = createClipboardService(runtime);

		// Get list of available entries for context
		const entries = await service.list();
		const entriesContext = entries
			.slice(0, MAX_CONTEXT_ENTRIES)
			.map((e) => `- ${e.id}: "${truncateText(e.title, MAX_TITLE_CHARS)}"`)
			.join("\n");
		const omittedContext =
			entries.length > MAX_CONTEXT_ENTRIES
				? `\n…${entries.length - MAX_CONTEXT_ENTRIES} more entries omitted.`
				: "";

		if (entries.length === 0) {
			if (callback) {
				await callback({
					text: "There are no clipboard entries to delete.",
					actions: ["CLIPBOARD_DELETE_EMPTY"],
					source: message.content.source,
				});
			}
			return { success: false, text: "No entries available" };
		}

		const deleteInfo = extractDeleteInfo(message, _options);

		if (!deleteInfo) {
			if (callback) {
				await callback({
					text: `I couldn't determine which note to delete. Available entries:\n${entriesContext}${omittedContext}`,
					actions: ["CLIPBOARD_DELETE_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to extract delete info" };
		}

		try {
			const deleted = await service.delete(deleteInfo.id);

			if (!deleted) {
				if (callback) {
					await callback({
						text: `Clipboard entry "${deleteInfo.id}" not found.`,
						actions: ["CLIPBOARD_DELETE_NOT_FOUND"],
						source: message.content.source,
					});
				}
				return { success: false, text: "Entry not found" };
			}

			const successMessage = `Successfully deleted clipboard entry "${deleteInfo.id}".`;

			if (callback) {
				await callback({
					text: successMessage,
					actions: ["CLIPBOARD_DELETE_SUCCESS"],
					source: message.content.source,
				});
			}

			return { success: true, text: successMessage };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardDelete] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to delete the note: ${errorMsg}`,
					actions: ["CLIPBOARD_DELETE_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to delete clipboard entry" };
		}
	},

	parameters: [
		{
			name: "id",
			description: "Clipboard entry ID to delete.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default clipboardDeleteAction;
