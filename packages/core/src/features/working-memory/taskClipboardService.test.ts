/**
 * Covers the task working-memory clipboard service against a real temporary
 * directory: persistence layout, content/title normalization, replacement by
 * sourceType+sourceId, newest-first ordering, per-entity store isolation and
 * id sanitization, missing-store defaults, corrupt-store failure, and the
 * CLIPBOARD_BASE_PATH runtime setting.
 *
 * Harness is integration-backed — real files on disk, no module mocks.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types/index.ts";
import {
	createTaskClipboardService,
	TASK_CLIPBOARD_MAX_ITEMS,
	type TaskClipboardService,
} from "./taskClipboardService.ts";

let baseDir: string;

beforeEach(async () => {
	baseDir = await mkdtemp(path.join(tmpdir(), "task-clipboard-test-"));
});

afterEach(async () => {
	await rm(baseDir, { recursive: true, force: true });
});

function makeService(
	config: Partial<
		Parameters<typeof TaskClipboardService.prototype.addItem>[0]
	> &
		Record<string, unknown> = {},
	runtime: IAgentRuntime = {} as IAgentRuntime,
): TaskClipboardService {
	return createTaskClipboardService(runtime, config as { basePath?: string });
}

async function readDefaultStoreFile(): Promise<string> {
	return readFile(path.join(baseDir, "clipboard.json"), "utf8");
}

describe("TaskClipboardService", () => {
	it("starts with an empty default snapshot when no store file exists", async () => {
		const service = makeService({ basePath: baseDir });

		await expect(service.getSnapshot()).resolves.toEqual({
			maxItems: TASK_CLIPBOARD_MAX_ITEMS,
			items: [],
		});
	});

	it("persists a manual item to clipboard.json with generated id and defaults", async () => {
		const service = makeService({ basePath: baseDir });

		const { item, replaced, snapshot } = await service.addItem({
			content: "hello world",
		});

		expect(replaced).toBe(false);
		expect(item.title).toBe("Clipboard Item");
		expect(item.sourceType).toBe("manual");
		expect(item.id).toMatch(/^cb-/);
		expect(item.content).toBe("hello world");
		expect(item.createdAt).toBe(item.updatedAt);
		expect(snapshot.items).toHaveLength(1);

		const raw = JSON.parse(await readDefaultStoreFile()) as {
			items: Array<{ id: string }>;
		};
		expect(raw.items.map((entry) => entry.id)).toEqual([item.id]);
	});

	it("collapses whitespace in titles and normalizes CRLF content", async () => {
		const service = makeService({ basePath: baseDir });

		const { item } = await service.addItem({
			title: "  spaced\n\n out \t title ",
			content: "line one\r\nline two\r\n",
		});

		expect(item.title).toBe("spaced out title");
		expect(item.content).toBe("line one\nline two");
	});

	it("rejects empty or whitespace-only content without persisting anything", async () => {
		const service = makeService({ basePath: baseDir });

		await expect(service.addItem({ content: "   " })).rejects.toThrow(
			"Clipboard items require non-empty content.",
		);
		const snapshot = await service.getSnapshot();
		expect(snapshot.items).toEqual([]);
	});

	it("derives default titles per source type", async () => {
		const service = makeService({ basePath: baseDir });

		const command = await service.addItem({
			content: "c",
			sourceType: "command",
			sourceLabel: "Deploy",
		});
		const attachment = await service.addItem({
			content: "a",
			sourceType: "attachment",
			sourceId: "att-9",
		});
		const file = await service.addItem({
			content: "f",
			sourceType: "file",
			sourceLabel: "notes.md",
		});
		const image = await service.addItem({
			content: "i",
			sourceType: "image_attachment",
		});

		expect(command.item.title).toBe("Deploy");
		expect(attachment.item.title).toBe("att-9");
		expect(file.item.title).toBe("notes.md");
		expect(image.item.title).toBe("Attachment");
	});

	it("replaces an existing item with the same sourceType and sourceId", async () => {
		const service = makeService({ basePath: baseDir });

		const first = await service.addItem({
			content: "v1",
			sourceType: "command",
			sourceId: "cmd-1",
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await service.addItem({
			content: "v2",
			sourceType: "command",
			sourceId: "cmd-1",
		});

		expect(second.replaced).toBe(true);
		expect(second.item.id).toBe(first.item.id);
		expect(second.item.createdAt).toBe(first.item.createdAt);
		expect(second.item.content).toBe("v2");
		const items = await service.listItems();
		expect(items).toHaveLength(1);
		expect(items[0].content).toBe("v2");
	});

	it("does not replace when sourceType differs even if sourceId matches", async () => {
		const service = makeService({ basePath: baseDir });

		await service.addItem({
			content: "manual note",
			sourceType: "manual",
			sourceId: "shared-id",
		});
		const commandAdd = await service.addItem({
			content: "command output",
			sourceType: "command",
			sourceId: "shared-id",
		});

		expect(commandAdd.replaced).toBe(false);
		const items = await service.listItems();
		expect(items).toHaveLength(2);
	});

	it("keeps newest items first after repeated adds", async () => {
		const service = makeService({ basePath: baseDir });

		const first = await service.addItem({ content: "older" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await service.addItem({ content: "newer" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const third = await service.addItem({ content: "newest" });

		const items = await service.listItems();
		expect(items.map((item) => item.id)).toEqual([
			third.item.id,
			second.item.id,
			first.item.id,
		]);
	});

	it("finds a stored item by id and returns null for unknown ids", async () => {
		const service = makeService({ basePath: baseDir });

		const { item } = await service.addItem({ content: "find me" });

		await expect(service.getItem(item.id)).resolves.toMatchObject({
			id: item.id,
		});
		await expect(service.getItem("cb-missing")).resolves.toBeNull();
	});

	it("removes existing items and reports misses without mutation", async () => {
		const service = makeService({ basePath: baseDir });

		const kept = await service.addItem({ content: "keep" });
		const dropped = await service.addItem({ content: "drop" });

		await expect(service.removeItem(dropped.item.id)).resolves.toMatchObject({
			removed: true,
		});
		let items = await service.listItems();
		expect(items.map((item) => item.id)).toEqual([kept.item.id]);

		await expect(
			service.removeItem("cb-does-not-exist"),
		).resolves.toMatchObject({ removed: false });
		items = await service.listItems();
		expect(items).toHaveLength(1);
	});

	it("isolates stores per entity and keeps them apart from the default store", async () => {
		const service = makeService({ basePath: baseDir });

		const alpha = await service.addItem(
			{ content: "alpha context" },
			"entity-a",
		);
		const beta = await service.addItem({ content: "beta context" }, "entity-b");
		const shared = await service.addItem({ content: "default scope" });

		await expect(service.listItems("entity-a")).resolves.toHaveLength(1);
		await expect(service.listItems("entity-b")).resolves.toHaveLength(1);
		await expect(service.listItems()).resolves.toHaveLength(1);

		await expect(
			readFile(path.join(baseDir, "clipboard", "entity-a.json"), "utf8"),
		).resolves.toContain(alpha.item.content);
		await expect(
			readFile(path.join(baseDir, "clipboard", "entity-b.json"), "utf8"),
		).resolves.toContain(beta.item.content);
		await expect(readDefaultStoreFile()).resolves.toContain(
			shared.item.content,
		);
	});

	it("sanitizes entity ids into safe filenames inside the clipboard directory", async () => {
		const service = makeService({ basePath: baseDir });

		await service.addItem({ content: "traversal probe" }, "user/../evil:id");

		await expect(
			readFile(path.join(baseDir, "clipboard", "user____evil_id.json"), "utf8"),
		).resolves.toContain("traversal probe");
	});

	it("fails loudly on a corrupt store instead of returning an empty state", async () => {
		const service = makeService({ basePath: baseDir });
		await writeFile(path.join(baseDir, "clipboard.json"), "{not json", "utf8");

		await expect(service.getSnapshot()).rejects.toMatchObject({
			code: "TASK_CLIPBOARD_READ_FAILED",
		});
	});

	it("drops malformed persisted entries but keeps structurally valid ones", async () => {
		const service = makeService({ basePath: baseDir });
		const valid = {
			id: "cb-valid",
			title: "Valid",
			content: "kept",
			sourceType: "manual",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await writeFile(
			path.join(baseDir, "clipboard.json"),
			JSON.stringify({
				version: 1,
				maxItems: 5,
				items: [null, valid, { title: "no content" }, "string entry"],
			}),
			"utf8",
		);

		const snapshot = await service.getSnapshot();
		expect(snapshot.maxItems).toBe(TASK_CLIPBOARD_MAX_ITEMS);
		expect(snapshot.items).toEqual([valid]);
	});

	it("honors the CLIPBOARD_BASE_PATH runtime setting when no explicit config wins", async () => {
		const runtime = {
			getSetting: (key: string) =>
				key === "CLIPBOARD_BASE_PATH" ? baseDir : null,
		} as unknown as IAgentRuntime;
		const service = createTaskClipboardService(runtime);

		const { item } = await service.addItem({ content: "via setting" });

		const raw = JSON.parse(await readDefaultStoreFile()) as {
			items: Array<{ id: string }>;
		};
		expect(raw.items.map((entry) => entry.id)).toContain(item.id);
	});
});
