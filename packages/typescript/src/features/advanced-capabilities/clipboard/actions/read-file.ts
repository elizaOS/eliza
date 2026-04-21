import * as fs from "node:fs/promises";
import * as path from "node:path";
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
import { maybeStoreTaskClipboardItem } from "../services/taskClipboardPersistence.ts";

const MAX_READ_FILE_BYTES = 128 * 1024;

type ReadFileInput = {
	filePath: string;
	from?: number;
	lines?: number;
};

function extractWorkdir(message: Memory, state?: State): string | null {
	if (
		typeof message.content.workdir === "string" &&
		message.content.workdir.trim()
	) {
		return message.content.workdir.trim();
	}
	const codingWorkspace = state?.codingWorkspace as
		| { path?: string }
		| undefined;
	if (
		typeof codingWorkspace?.path === "string" &&
		codingWorkspace.path.trim()
	) {
		return codingWorkspace.path.trim();
	}
	return null;
}

function resolveFilePath(
	inputPath: string,
	message: Memory,
	state?: State,
): string {
	if (path.isAbsolute(inputPath)) {
		return path.normalize(inputPath);
	}
	const workdir = extractWorkdir(message, state);
	return path.resolve(workdir ?? process.cwd(), inputPath);
}

function hasReadFilePath(obj: Record<string, unknown>): boolean {
	return typeof obj.filePath === "string" && obj.filePath.trim().length > 0;
}

async function extractReadFileInput(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<ReadFileInput | null> {
	const explicitPath =
		typeof message.content.filePath === "string"
			? message.content.filePath.trim()
			: typeof message.content.path === "string"
				? message.content.path.trim()
				: "";
	if (explicitPath) {
		return {
			filePath: explicitPath,
			from:
				typeof message.content.from === "number"
					? message.content.from
					: undefined,
			lines:
				typeof message.content.lines === "number"
					? message.content.lines
					: undefined,
		};
	}
	const text =
		typeof message.content.text === "string" ? message.content.text : "";
	if (!text.trim()) {
		return null;
	}
	const response = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt: [
			"Extract the file path and optional line range to read.",
			"",
			`User message: ${text}`,
			"",
			"Respond with XML:",
			"<response><filePath>relative/or/absolute/path</filePath><from>1</from><lines>40</lines></response>",
		].join("\n"),
		stopSequences: [],
	});
	const parsed = parseKeyValueXml(String(response)) as Record<
		string,
		unknown
	> | null;
	if (!parsed || !hasReadFilePath(parsed)) {
		return null;
	}
	const filePath = String(parsed.filePath);
	const fromValue = parsed.from;
	const linesValue = parsed.lines;
	return {
		filePath: filePath.trim(),
		from:
			typeof fromValue === "string" && fromValue.trim()
				? Number(fromValue)
				: undefined,
		lines:
			typeof linesValue === "string" && linesValue.trim()
				? Number(linesValue)
				: undefined,
	};
}

export async function readFileFromActionInput(
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	explicitInput?: Partial<ReadFileInput>,
): Promise<{
	filePath: string;
	content: string;
	truncated: boolean;
	from: number;
	linesRead: number;
}> {
	const inferred = explicitInput?.filePath
		? ({
				filePath: explicitInput.filePath,
				from: explicitInput.from,
				lines: explicitInput.lines,
			} satisfies ReadFileInput)
		: await extractReadFileInput(runtime, message);

	if (!inferred) {
		throw new Error("I couldn't determine which file to read.");
	}

	const resolvedPath = resolveFilePath(inferred.filePath, message, state);
	const stat = await fs.stat(resolvedPath);
	if (!stat.isFile()) {
		throw new Error(`Not a file: ${resolvedPath}`);
	}

	const raw = await fs.readFile(resolvedPath);
	if (raw.includes(0)) {
		throw new Error(`Refusing to read binary file: ${resolvedPath}`);
	}

	let text = raw.toString("utf8");
	const fromLine = Math.max(1, inferred.from ?? 1);
	if (fromLine > 1 || typeof inferred.lines === "number") {
		const allLines = text.split("\n");
		const startIndex = fromLine - 1;
		const lineCount = Math.max(
			1,
			inferred.lines ?? allLines.length - startIndex,
		);
		text = allLines.slice(startIndex, startIndex + lineCount).join("\n");
	}

	const truncated = Buffer.byteLength(text, "utf8") > MAX_READ_FILE_BYTES;
	const finalContent = truncated ? text.slice(0, MAX_READ_FILE_BYTES) : text;

	return {
		filePath: resolvedPath,
		content: finalContent,
		truncated,
		from: fromLine,
		linesRead: finalContent.split("\n").length,
	};
}

export const readFileAction: Action = {
	name: "READ_FILE",
	similes: ["OPEN_FILE", "LOAD_FILE"],
	description:
		"Read a local text file for the current task. Returns the file content so the agent can reference it. Set addToClipboard=true to keep the read result in bounded task clipboard state.",
	validate: async (_runtime, message) =>
		typeof message.content.filePath === "string" ||
		typeof message.content.path === "string" ||
		/(?:read|open|inspect).*(?:file|path)/i.test(
			String(message.content.text ?? ""),
		),
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const result = await readFileFromActionInput(runtime, message, state);
			const clipboardResult = await maybeStoreTaskClipboardItem(
				runtime,
				message,
				{
					fallbackTitle: path.basename(result.filePath),
					content: result.content,
					sourceType: "file",
					sourceId: result.filePath,
					sourceLabel: result.filePath,
				},
			);
			let clipboardStatusText = "";
			if (clipboardResult.requested) {
				if (clipboardResult.stored) {
					clipboardStatusText = `${clipboardResult.replaced ? "Updated" : "Added"} clipboard item ${clipboardResult.item.id}: ${clipboardResult.item.title}`;
				} else if ("reason" in clipboardResult) {
					clipboardStatusText = `Clipboard add skipped: ${clipboardResult.reason}`;
				}
			}
			const responseText = [
				`Read file: ${result.filePath}`,
				`Lines: ${result.from}-${result.from + result.linesRead - 1}`,
				result.truncated ? "(truncated to 128 KB)" : "",
				clipboardStatusText,
				clipboardResult.requested && clipboardResult.stored
					? `Clipboard usage: ${clipboardResult.snapshot.items.length}/${clipboardResult.snapshot.maxItems}.`
					: "",
				clipboardResult.requested && clipboardResult.stored
					? "Clear unused clipboard state when it is no longer needed."
					: "",
				"",
				result.content,
			]
				.filter(Boolean)
				.join("\n");

			if (callback) {
				await callback({
					text: responseText,
					actions: ["READ_FILE_SUCCESS"],
					source: message.content.source,
				});
			}

			return {
				success: true,
				text: responseText,
				data: {
					...result,
					clipboard: clipboardResult,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardReadFile] Error:", errorMessage);
			if (callback) {
				await callback({
					text: `Failed to read file: ${errorMessage}`,
					actions: ["READ_FILE_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: "Failed to read file",
				error: errorMessage,
			};
		}
	},
	examples: [],
};

export default readFileAction;
