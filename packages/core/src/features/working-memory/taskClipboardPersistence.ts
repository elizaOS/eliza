import type { IAgentRuntime, Memory } from "../../types/index.ts";
import type {
	AddTaskClipboardItemInput,
	TaskClipboardItem,
	TaskClipboardSnapshot,
} from "./taskClipboardService.ts";
import { createTaskClipboardService } from "./taskClipboardService.ts";

type TaskClipboardPersistenceInput = AddTaskClipboardItemInput & {
	fallbackTitle?: string;
};

export type TaskClipboardPersistenceResult =
	| {
			requested: false;
			stored: false;
	  }
	| {
			requested: true;
			stored: true;
			replaced: boolean;
			item: TaskClipboardItem;
			snapshot: TaskClipboardSnapshot;
	  }
	| {
			requested: true;
			stored: false;
			reason: string;
	  };

function isTruthyFlag(value: unknown): boolean {
	if (value === true) {
		return true;
	}
	if (typeof value === "string") {
		return /^(true|1|yes|y|on)$/i.test(value.trim());
	}
	return false;
}

function normalizeTitle(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function shouldAddToClipboard(message: Memory): boolean {
	return (
		isTruthyFlag(message.content.addToClipboard) ||
		isTruthyFlag(message.content.persistToClipboard) ||
		isTruthyFlag(message.content.saveToClipboard)
	);
}

export function resolveClipboardTitle(
	message: Memory,
	fallbackTitle?: string,
): string | undefined {
	return (
		normalizeTitle(message.content.clipboardTitle) ??
		normalizeTitle(message.content.title) ??
		normalizeTitle(fallbackTitle) ??
		undefined
	);
}

export async function maybeStoreTaskClipboardItem(
	runtime: IAgentRuntime,
	message: Memory,
	input: TaskClipboardPersistenceInput,
): Promise<TaskClipboardPersistenceResult> {
	if (!shouldAddToClipboard(message)) {
		return { requested: false, stored: false };
	}

	const content = input.content.trim();
	if (!content) {
		return {
			requested: true,
			stored: false,
			reason: "No stored content was available to save in the clipboard.",
		};
	}

	try {
		const entityId =
			typeof message.entityId === "string" ? message.entityId : undefined;
		const service = createTaskClipboardService(runtime);
		const { item, replaced, snapshot } = await service.addItem(
			{
				...input,
				content,
				title:
					input.title ?? resolveClipboardTitle(message, input.fallbackTitle),
			},
			entityId,
		);
		return {
			requested: true,
			stored: true,
			replaced,
			item,
			snapshot,
		};
	} catch (error) {
		return {
			requested: true,
			stored: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
