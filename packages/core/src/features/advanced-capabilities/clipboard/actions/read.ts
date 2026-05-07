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

interface ReadInput {
	id: string;
	from?: number;
	lines?: number;
}

function isValidReadInput(obj: Record<string, unknown>): boolean {
	return typeof obj.id === "string" && obj.id.length > 0;
}

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function optionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function extractReadInfo(
	message: Memory,
	options?: HandlerOptions,
): ReadInput | null {
	const params = readParams(options);
	const raw = {
		id: params.id ?? message.content.id ?? message.content.entryId,
		from: params.from ?? message.content.from,
		lines: params.lines ?? message.content.lines,
	};

	if (!isValidReadInput(raw)) {
		logger.error("[ClipboardRead] Failed to extract valid read info");
		return null;
	}

	return {
		id: String(raw.id),
		from: optionalNumber(raw.from),
		lines: optionalNumber(raw.lines),
	};
}

const spec = requireActionSpec("CLIPBOARD_READ");

export const clipboardReadAction: Action = {
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
		if (isValidReadInput(__avParams)) {
			return true;
		}
		return hasActionContextOrKeyword(message, state, {
			contexts: ["files", "knowledge", "agent_internal"],
			keywords: ["clipboard", "read note", "open note", "show note"],
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
			.map((e) => `- ${e.id}: "${e.title}"`)
			.join("\n");

		if (entries.length === 0) {
			if (callback) {
				await callback({
					text: "There are no clipboard entries to read. You can create one first.",
					actions: ["CLIPBOARD_READ_EMPTY"],
					source: message.content.source,
				});
			}
			return { success: false, text: "No entries available" };
		}

		const readInfo = extractReadInfo(message, _options);

		if (!readInfo) {
			if (callback) {
				await callback({
					text: `I couldn't determine which note to read. Available entries:\n${entriesContext}`,
					actions: ["CLIPBOARD_READ_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to extract read info" };
		}

		try {
			const entry = await service.read(readInfo.id, {
				from: readInfo.from,
				lines: readInfo.lines,
			});

			const lineInfo =
				readInfo.from !== undefined
					? ` (lines ${readInfo.from}-${(readInfo.from ?? 1) + (readInfo.lines ?? 10)})`
					: "";

			const successMessage = `**${entry.title}**${lineInfo}\n\n${entry.content}`;

			if (callback) {
				await callback({
					text: successMessage,
					actions: ["CLIPBOARD_READ_SUCCESS"],
					source: message.content.source,
				});
			}

			return { success: true, text: successMessage, entry };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardRead] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to read the note: ${errorMsg}`,
					actions: ["CLIPBOARD_READ_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to read clipboard entry" };
		}
	},

	parameters: [
		{
			name: "id",
			description: "Clipboard entry ID to read.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "from",
			description: "Optional 1-based starting line number.",
			required: false,
			schema: { type: "number" as const, minimum: 1 },
		},
		{
			name: "lines",
			description: "Optional maximum number of lines to read.",
			required: false,
			schema: { type: "number" as const, minimum: 1 },
		},
	],
	examples: [],
};

export default clipboardReadAction;
