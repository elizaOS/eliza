import {
	type Action,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	parseKeyValueXml,
	type State,
} from "../../../../types/index.ts";
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

const EXTRACT_TEMPLATE = `Extract the clipboard entry ID and optional line range from the user's message.

User message: {{text}}

Available clipboard entries:
{{entries}}

Respond with XML containing:
- id: The ID of the clipboard entry to read (required)
- from: Starting line number (optional)
- lines: Number of lines to read (optional)

<response>
<id>entry-id</id>
<from>1</from>
<lines>10</lines>
</response>`;

async function extractReadInfo(
	runtime: IAgentRuntime,
	message: Memory,
	availableEntries: string,
): Promise<ReadInput | null> {
	const prompt = EXTRACT_TEMPLATE.replace(
		"{{text}}",
		message.content.text ?? "",
	).replace("{{entries}}", availableEntries);

	const result = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
		stopSequences: [],
	});

	logger.debug("[ClipboardRead] Extract result:", result);

	const parsed = parseKeyValueXml(String(result)) as Record<
		string,
		unknown
	> | null;

	if (!parsed || !isValidReadInput(parsed)) {
		logger.error("[ClipboardRead] Failed to extract valid read info");
		return null;
	}

	return {
		id: String(parsed.id),
		from: parsed.from ? Number(parsed.from) : undefined,
		lines: parsed.lines ? Number(parsed.lines) : undefined,
	};
}

const spec = requireActionSpec("CLIPBOARD_READ");

export const clipboardReadAction: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const __avTextRaw =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const __avText = __avTextRaw.toLowerCase();
		const __avKeywords = ["clipboard", "read"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
		const __avRegex = /\b(?:clipboard|read)\b/i;
		const __avRegexOk = __avRegex.test(__avText);
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avInputOk =
			__avText.trim().length > 0 ||
			Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
			Boolean(message?.content && typeof message.content === "object");

		if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
			return false;
		}

		const __avLegacyValidate = async (
			_runtime: IAgentRuntime,
			_message: Memory,
		): Promise<boolean> => {
			return true;
		};
		try {
			return Boolean(await __avLegacyValidate(runtime, message));
		} catch {
			return false;
		}
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

		const readInfo = await extractReadInfo(runtime, message, entriesContext);

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

	examples: [],
};

export default clipboardReadAction;
