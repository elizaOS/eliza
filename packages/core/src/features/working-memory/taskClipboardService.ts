/**
 * Task working-memory clipboard service.
 * Stores bounded per-entity action results for use within the current task context.
 * This is NOT the user-facing todo list — it is runtime-internal working memory.
 */
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "../../types/index.ts";
import { logger } from "../../types/index.ts";

// --- Inlined types ---

export type TaskClipboardSourceType =
	| "manual"
	| "command"
	| "file"
	| "attachment"
	| "image_attachment"
	| "channel"
	| "conversation_search"
	| "entity"
	| "entity_search"
	| "action_result";

export interface TaskClipboardItem {
	id: string;
	title: string;
	content: string;
	sourceType: TaskClipboardSourceType;
	sourceId?: string;
	sourceLabel?: string;
	mimeType?: string;
	createdAt: string;
	updatedAt: string;
}

export interface TaskClipboardSnapshot {
	maxItems: number;
	items: TaskClipboardItem[];
}

export interface AddTaskClipboardItemInput {
	title?: string;
	content: string;
	sourceType?: TaskClipboardSourceType;
	sourceId?: string;
	sourceLabel?: string;
	mimeType?: string;
}

interface WorkingMemoryConfig {
	basePath: string;
	maxFileSize?: number;
	allowedExtensions?: string[];
}

export const TASK_CLIPBOARD_MAX_ITEMS = 5;

// --- Config ---

function defaultBasePath(): string {
	return path.join(os.homedir(), ".eliza", "clipboard");
}

function readStringSetting(
	runtime: IAgentRuntime | undefined,
	key: string,
): string | null {
	const direct = runtime?.getSetting?.(key);
	if (typeof direct === "string" && direct.trim()) return direct.trim();
	const envValue = process.env[key];
	return typeof envValue === "string" && envValue.trim()
		? envValue.trim()
		: null;
}

function resolveConfig(
	config?: Partial<WorkingMemoryConfig>,
	runtime?: IAgentRuntime,
): WorkingMemoryConfig {
	const basePath = readStringSetting(runtime, "CLIPBOARD_BASE_PATH");
	return {
		basePath: basePath ?? defaultBasePath(),
		maxFileSize: 1024 * 1024,
		allowedExtensions: [".md", ".txt"],
		...config,
	};
}

// --- Store ---

const TASK_CLIPBOARD_FILE = "clipboard.json";
const CLIPBOARD_DIR = "clipboard";

type TaskClipboardStore = {
	version: 1;
	maxItems: number;
	items: TaskClipboardItem[];
};

function createDefaultStore(): TaskClipboardStore {
	return { version: 1, maxItems: TASK_CLIPBOARD_MAX_ITEMS, items: [] };
}

function sanitizeTitle(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function defaultTitleForInput(input: AddTaskClipboardItemInput): string {
	if (input.title?.trim()) return sanitizeTitle(input.title);
	if (input.sourceType === "command") {
		return sanitizeTitle(input.sourceLabel ?? input.sourceId ?? "Command");
	}
	if (
		input.sourceType === "attachment" ||
		input.sourceType === "image_attachment"
	) {
		return sanitizeTitle(input.sourceLabel ?? input.sourceId ?? "Attachment");
	}
	if (input.sourceType === "file") {
		return sanitizeTitle(input.sourceLabel ?? input.sourceId ?? "File");
	}
	return "Clipboard Item";
}

function normalizeContent(content: string): string {
	return content.replace(/\r\n/g, "\n").trim();
}

export class TaskClipboardService {
	private readonly config: WorkingMemoryConfig;

	constructor(runtime: IAgentRuntime, config?: Partial<WorkingMemoryConfig>) {
		this.config = resolveConfig(config, runtime);
	}

	private async ensureDirectory(subdir?: string): Promise<void> {
		const dir = subdir
			? path.join(this.config.basePath, subdir)
			: this.config.basePath;
		await fs.mkdir(dir, { recursive: true });
	}

	private getStorePath(entityId?: string): string {
		if (entityId) {
			const safeId = entityId.replace(/[^a-zA-Z0-9_-]/g, "_");
			return path.join(this.config.basePath, CLIPBOARD_DIR, `${safeId}.json`);
		}
		return path.join(this.config.basePath, TASK_CLIPBOARD_FILE);
	}

	private async readStore(entityId?: string): Promise<TaskClipboardStore> {
		const storePath = this.getStorePath(entityId);
		const dir = path.dirname(storePath);
		await this.ensureDirectory(
			dir === this.config.basePath
				? undefined
				: path.relative(this.config.basePath, dir),
		);
		try {
			const raw = await fs.readFile(storePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<TaskClipboardStore> | null;
			if (!parsed || !Array.isArray(parsed.items)) {
				return createDefaultStore();
			}
			return {
				version: 1,
				maxItems:
					typeof parsed.maxItems === "number" && parsed.maxItems > 0
						? parsed.maxItems
						: TASK_CLIPBOARD_MAX_ITEMS,
				items: parsed.items
					.filter((item): item is TaskClipboardItem =>
						Boolean(
							item &&
								typeof item.id === "string" &&
								typeof item.title === "string" &&
								typeof item.content === "string" &&
								typeof item.sourceType === "string" &&
								typeof item.createdAt === "string" &&
								typeof item.updatedAt === "string",
						),
					)
					.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return createDefaultStore();
			}
			logger.warn(
				"[TaskClipboardService] Failed to read task clipboard store:",
				error instanceof Error ? error.message : String(error),
			);
			return createDefaultStore();
		}
	}

	private async writeStore(
		store: TaskClipboardStore,
		entityId?: string,
	): Promise<void> {
		const storePath = this.getStorePath(entityId);
		const dir = path.dirname(storePath);
		await this.ensureDirectory(
			dir === this.config.basePath
				? undefined
				: path.relative(this.config.basePath, dir),
		);
		const tempPath = `${storePath}.tmp-${crypto.randomUUID()}`;
		await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
		await fs.rename(tempPath, storePath);
	}

	async getSnapshot(entityId?: string): Promise<TaskClipboardSnapshot> {
		const store = await this.readStore(entityId);
		return { maxItems: store.maxItems, items: [...store.items] };
	}

	async listItems(entityId?: string): Promise<TaskClipboardItem[]> {
		const snapshot = await this.getSnapshot(entityId);
		return snapshot.items;
	}

	async getItem(
		id: string,
		entityId?: string,
	): Promise<TaskClipboardItem | null> {
		const items = await this.listItems(entityId);
		return items.find((item) => item.id === id) ?? null;
	}

	async addItem(
		input: AddTaskClipboardItemInput,
		entityId?: string,
	): Promise<{
		item: TaskClipboardItem;
		replaced: boolean;
		snapshot: TaskClipboardSnapshot;
	}> {
		const content = normalizeContent(input.content);
		if (!content) {
			throw new Error("Clipboard items require non-empty content.");
		}
		const store = await this.readStore(entityId);
		const now = new Date().toISOString();

		const replacementIndex =
			input.sourceType && input.sourceId
				? store.items.findIndex(
						(item) =>
							item.sourceType === input.sourceType &&
							item.sourceId === input.sourceId,
					)
				: -1;

		if (replacementIndex === -1 && store.items.length >= store.maxItems) {
			throw new Error(
				`Clipboard is full (${store.items.length}/${store.maxItems}). Remove an unused item before adding another.`,
			);
		}

		const existing =
			replacementIndex >= 0 ? store.items[replacementIndex] : null;
		const item: TaskClipboardItem = {
			id: existing?.id ?? `cb-${crypto.randomUUID().slice(0, 8)}`,
			title: defaultTitleForInput(input),
			content,
			sourceType: input.sourceType ?? "manual",
			...(input.sourceId ? { sourceId: input.sourceId } : {}),
			...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
			...(input.mimeType ? { mimeType: input.mimeType } : {}),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		if (replacementIndex >= 0) {
			store.items[replacementIndex] = item;
		} else {
			store.items.unshift(item);
		}

		store.items.sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
		await this.writeStore(store, entityId);

		return {
			item,
			replaced: replacementIndex >= 0,
			snapshot: {
				maxItems: store.maxItems,
				items: [...store.items],
			},
		};
	}

	async removeItem(
		id: string,
		entityId?: string,
	): Promise<{
		removed: boolean;
		snapshot: TaskClipboardSnapshot;
	}> {
		const store = await this.readStore(entityId);
		const nextItems = store.items.filter((item) => item.id !== id);
		if (nextItems.length === store.items.length) {
			return {
				removed: false,
				snapshot: { maxItems: store.maxItems, items: [...store.items] },
			};
		}
		store.items = nextItems;
		await this.writeStore(store, entityId);
		return {
			removed: true,
			snapshot: { maxItems: store.maxItems, items: [...store.items] },
		};
	}
}

export function createTaskClipboardService(
	runtime: IAgentRuntime,
	config?: Partial<WorkingMemoryConfig>,
): TaskClipboardService {
	return new TaskClipboardService(runtime, config);
}
