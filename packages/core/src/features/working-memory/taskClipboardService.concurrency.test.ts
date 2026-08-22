/**
 * Concurrency coverage for the per-entity task clipboard store.
 *
 * The clipboard file is keyed by entity and lives under the shared process
 * state dir, so two handler runs for the same person — one user active in two
 * rooms, or two agent runtimes in one process — read-modify-write the same
 * JSON file. Both callers are told the item was stored, so a lost update is
 * silent persisted data loss rather than a reported failure.
 *
 * A real temp directory is the backing store; nothing mocks the module under
 * test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IAgentRuntime, UUID } from "../../types/index.ts";
import {
	type AddTaskClipboardItemInput,
	TaskClipboardService,
} from "./taskClipboardService.ts";

const runtime = {
	getSetting: () => undefined,
} as unknown as IAgentRuntime;

const entityId = "00000000-0000-0000-0000-000000000011" as UUID;

let basePath: string;

beforeEach(async () => {
	basePath = await mkdtemp(path.join(tmpdir(), "eliza-task-clipboard-"));
});

afterEach(async () => {
	await rm(basePath, { recursive: true, force: true });
});

describe("TaskClipboardService concurrent store mutations", () => {
	it("persists every item when two adds for one entity overlap", async () => {
		const service = new TaskClipboardService(runtime, { basePath });

		const results = await Promise.all([
			service.addItem({ content: "alpha", sourceType: "manual" }, entityId),
			service.addItem({ content: "bravo", sourceType: "manual" }, entityId),
		]);

		// Both calls reported success to their handler, so both items must be on
		// disk. A lost update leaves one id that no read can ever return.
		const persisted = await service.listItems(entityId);
		expect(persisted.map((item) => item.content).sort()).toEqual([
			"alpha",
			"bravo",
		]);
		for (const { item } of results) {
			expect(await service.getItem(item.id, entityId)).not.toBeNull();
		}
	});

	it("persists every item when the store is filled concurrently", async () => {
		const service = new TaskClipboardService(runtime, { basePath });
		const contents = ["one", "two", "three", "four", "five"];

		await Promise.all(
			contents.map((content) =>
				service.addItem({ content, sourceType: "manual" }, entityId),
			),
		);

		const persisted = await service.listItems(entityId);
		expect(persisted.map((item) => item.content).sort()).toEqual(
			[...contents].sort(),
		);
	});

	it("keeps a removal durable against an overlapping add", async () => {
		const service = new TaskClipboardService(runtime, { basePath });
		const doomed = await service.addItem(
			{ content: "doomed", sourceType: "manual" },
			entityId,
		);

		await Promise.all([
			service.removeItem(doomed.item.id, entityId),
			service.addItem({ content: "fresh", sourceType: "manual" }, entityId),
		]);

		const persisted = await service.listItems(entityId);
		expect(persisted.map((item) => item.id)).not.toContain(doomed.item.id);
		expect(persisted.map((item) => item.content)).toContain("fresh");
	});

	it("keeps sequential behaviour unchanged", async () => {
		const service = new TaskClipboardService(runtime, { basePath });

		const first = await service.addItem(
			{ content: "alpha", sourceType: "command", sourceId: "cmd-1" },
			entityId,
		);
		const replaced = await service.addItem(
			{ content: "alpha-2", sourceType: "command", sourceId: "cmd-1" },
			entityId,
		);
		expect(replaced.replaced).toBe(true);
		expect(replaced.item.id).toBe(first.item.id);

		const removed = await service.removeItem(first.item.id, entityId);
		expect(removed.removed).toBe(true);
		expect(removed.snapshot.items).toHaveLength(0);

		const missing = await service.removeItem(first.item.id, entityId);
		expect(missing.removed).toBe(false);
	});

	it("continues the mutation chain after a rejected operation", async () => {
		const service = new TaskClipboardService(runtime, { basePath });
		const rejectedInput: AddTaskClipboardItemInput = {
			content: "rejected",
			get sourceType() {
				throw new Error("injected mutation failure");
			},
		};

		const rejected = service.addItem(rejectedInput, entityId);
		const successor = service.addItem(
			{ content: "successor", sourceType: "manual" },
			entityId,
		);

		await expect(rejected).rejects.toThrow("injected mutation failure");
		await expect(successor).resolves.toMatchObject({
			item: { content: "successor" },
		});
		expect(
			(await service.listItems(entityId)).map((item) => item.content),
		).toEqual(["successor"]);
	});
});
