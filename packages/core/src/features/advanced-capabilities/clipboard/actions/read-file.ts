import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Action,
	type ContentValue,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
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

function _hasReadFilePath(obj: Record<string, unknown>): boolean {
	return typeof obj.filePath === "string" && obj.filePath.trim().length > 0;
}

function getActionParams(
	options: HandlerOptions | undefined,
): Record<string, unknown> {
	const direct =
		options && typeof options === "object"
			? (options as Record<string, unknown>)
			: {};
	const parameters =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	return { ...direct, ...parameters };
}

function readNumberParam(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function explicitReadFileInput(
	params: Record<string, unknown>,
): Partial<ReadFileInput> | undefined {
	const filePath =
		typeof params.filePath === "string" && params.filePath.trim()
			? params.filePath.trim()
			: typeof params.path === "string" && params.path.trim()
				? params.path.trim()
				: "";
	if (!filePath) return undefined;
	return {
		filePath,
		from: readNumberParam(params.from),
		lines: readNumberParam(params.lines),
	};
}

function readClipboardContentOverrides(
	params: Record<string, unknown>,
): Partial<Memory["content"]> {
	const overrides: Record<string, ContentValue> = {};
	for (const key of [
		"addToClipboard",
		"persistToClipboard",
		"saveToClipboard",
		"clipboardTitle",
		"title",
	]) {
		const value = params[key];
		if (
			typeof value === "string" ||
			typeof value === "boolean" ||
			typeof value === "number"
		) {
			overrides[key] = value;
		}
	}
	return overrides as Partial<Memory["content"]>;
}

function extractReadFileInput(message: Memory): ReadFileInput | null {
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
	const pathMatch =
		text.match(/(?:file|path)\s+["'`](.+?)["'`]/i) ??
		text.match(/["'`](.+?\.[\w.-]+)["'`]/) ??
		text.match(/((?:\.{1,2}\/|\/)[^\s,;]+|[A-Za-z]:[\\/][^\s,;]+)/);
	const filePath = pathMatch?.[1]?.trim();
	if (!filePath) {
		return null;
	}
	const fromValue = text.match(/\bfrom\s+line\s+(\d+)/i)?.[1];
	const linesValue =
		text.match(/\b(?:first|next|limit|lines)\s+(\d+)/i)?.[1] ??
		text.match(/\b(\d+)\s+lines\b/i)?.[1];
	return {
		filePath,
		from: fromValue ? Number(fromValue) : undefined,
		lines: linesValue ? Number(linesValue) : undefined,
	};
}

export async function readFileFromActionInput(
	_runtime: IAgentRuntime,
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
		: extractReadFileInput(message);

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
	suppressPostActionContinuation: true,
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		const params = message.content as Record<string, unknown>;
		if (explicitReadFileInput(params)) {
			return true;
		}
		if (
			typeof message.content.filePath === "string" ||
			typeof message.content.path === "string"
		) {
			return true;
		}
		const rawText = String(message.content.text ?? "");
		const safeText =
			rawText.length > 10_000 ? rawText.slice(0, 10_000) : rawText;
		return /(?:read|open|inspect).*(?:file|path)/i.test(safeText);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const params = getActionParams(_options);
			const messageWithParams: Memory = {
				...message,
				content: {
					...message.content,
					...readClipboardContentOverrides(params),
				},
			};
			const result = await readFileFromActionInput(
				runtime,
				messageWithParams,
				state,
				explicitReadFileInput(params),
			);
			const clipboardResult = await maybeStoreTaskClipboardItem(
				runtime,
				messageWithParams,
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
					actionName: "READ_FILE",
					...result,
					clipboard: clipboardResult,
					suppressActionResultClipboard: clipboardResult.requested,
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
				data: { actionName: "READ_FILE" },
			};
		}
	},
	parameters: [
		{
			name: "filePath",
			description:
				"Absolute or workspace-relative path to the text file to read.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "from",
			description: "1-based starting line number.",
			required: false,
			schema: { type: "number" as const, minimum: 1 },
		},
		{
			name: "lines",
			description: "Maximum number of lines to read.",
			required: false,
			schema: { type: "number" as const, minimum: 1 },
		},
		{
			name: "addToClipboard",
			description:
				"When true, store the read content in bounded task clipboard state.",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},
	],
	examples: [],
};

export default readFileAction;
