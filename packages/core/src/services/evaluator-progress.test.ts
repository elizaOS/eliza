/** Revision progress and staged-output recovery; durable cache is a JSON round-trip double. */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../types/index.ts";
import {
	assertExtractionSourcesUnchanged,
	commitEvaluatorProgress,
	type EvaluatorProgressSnapshot,
	prepareEvaluatorProgress as prepareProgress,
	stageEvaluatorOutput,
} from "./evaluator-progress.ts";

const AGENT = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM = "00000000-0000-0000-0000-000000000002" as UUID;
const USER = "00000000-0000-0000-0000-000000000003" as UUID;
const OTHER = "00000000-0000-0000-0000-000000000004" as UUID;

function memory(
	id: string,
	text: string,
	overrides: Partial<Memory> = {},
): Memory {
	return {
		id: id as UUID,
		agentId: AGENT,
		roomId: ROOM,
		entityId: USER,
		createdAt: 100,
		content: { text },
		...overrides,
	};
}

function runtimeWith(store = new Map<string, unknown>(), agentId = AGENT) {
	const getCache = vi.fn(
		async <T>(key: string): Promise<T | undefined> =>
			store.has(key) ? (structuredClone(store.get(key)) as T) : undefined,
	);
	const setCache = vi.fn(async <T>(key: string, value: T): Promise<boolean> => {
		store.set(key, JSON.parse(JSON.stringify(value)));
		return true;
	});
	const getMemories = vi.fn(async (): Promise<Memory[]> => []);
	const runtime = {
		agentId,
		getCache,
		setCache,
		getMemories,
	} as unknown as IAgentRuntime;
	authoritativeRows.set(runtime, (rows) =>
		getMemories.mockResolvedValue(structuredClone(rows)),
	);
	return {
		runtime,
		store,
		getCache,
		setCache,
		getMemories,
	};
}

// Preparing test fixtures updates the authoritative DB double separately from
// the production helper; tests can mutate it again while a batch is in flight.
const authoritativeRows = new WeakMap<
	IAgentRuntime,
	(rows: readonly Memory[]) => void
>();
async function prepareEvaluatorProgress(
	runtime: IAgentRuntime,
	message: Memory,
	evaluatorNames: readonly string[],
	completeMessages: readonly Memory[],
) {
	authoritativeRows.get(runtime)?.(completeMessages);
	return prepareProgress(runtime, message, evaluatorNames, completeMessages);
}

function selected(
	snapshots: Map<string, EvaluatorProgressSnapshot>,
	name = "facts",
) {
	const snapshot = snapshots.get(name);
	if (!snapshot) throw new Error(`Missing ${name} snapshot`);
	return snapshot;
}

describe("incremental evaluator progress", () => {
	it("backfills every record without clipping or mutating persisted history", async () => {
		const { runtime, store } = runtimeWith();
		const old = memory(
			"old",
			`START ${"complete historical evidence ".repeat(4000)} END`,
			{
				embedding: [0.1, 0.2],
				similarity: 0.9,
			},
		);
		const trigger = memory("trigger", "Remember this");
		const originals = structuredClone([old, trigger]);
		const snapshot = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[old, trigger],
			),
		);
		expect(snapshot.messages.map((row) => row.id)).toEqual(["old", "trigger"]);
		expect(snapshot.messages[0].content.text).toBe(old.content.text);
		expect(snapshot.messages[0].embedding).toBeUndefined();
		expect(snapshot.sourceRevisions.old).toMatch(/^[a-f0-9]{64}$/);
		expect(snapshot.changedMessageIds).toEqual([]);
		expect(snapshot.isBackfill).toBe(true);
		expect(snapshot.removedMessageIds).toEqual([]);
		expect([old, trigger]).toEqual(originals);
		expect(store.size).toBe(0);
	});

	it("commits only staged successful work and leaves unchanged rows out of the next batch", async () => {
		const { runtime } = runtimeWith();
		const trigger = memory("trigger", "A durable fact");
		const snapshot = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		await expect(
			commitEvaluatorProgress(runtime, snapshot),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_NOT_STAGED" });
		await stageEvaluatorOutput(runtime, snapshot, { facts: [] });
		await commitEvaluatorProgress(runtime, snapshot);
		const next = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		expect(next.messages).toEqual([]);
		expect(next.isBackfill).toBe(false);
		expect(next.pendingOutput).toBeUndefined();
	});

	it("detects backdated additions, same-ID edits, metadata revisions and removals", async () => {
		const { runtime } = runtimeWith();
		const original = memory("old", "Old content");
		const removed = memory("removed", "Will be deleted");
		const trigger = memory("trigger", "Run extraction");
		const first = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[original, removed, trigger],
			),
		);
		await stageEvaluatorOutput(runtime, first, {});
		await commitEvaluatorProgress(runtime, first);
		const edit = { ...original, content: { text: "Edited content" } };
		const backdated = memory("backdated", "Discovered later", { createdAt: 1 });
		const second = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[edit, backdated, trigger],
			),
		);
		expect(second.messages.map((row) => row.id)).toEqual(["old", "backdated"]);
		expect(second.changedMessageIds).toEqual(["old"]);
		expect(second.removedMessageIds).toEqual(["removed"]);
		await stageEvaluatorOutput(runtime, second, {});
		await commitEvaluatorProgress(runtime, second);
		const metadataEdit = { ...edit, metadata: { type: "custom", revision: 2 } };
		const third = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[metadataEdit, backdated, trigger],
			),
		);
		expect(third.changedMessageIds).toEqual(["old"]);
	});

	it("does not reinterpret vector refreshes or source key order as content edits", async () => {
		const { runtime } = runtimeWith();
		const trigger = memory("trigger", "Same text", {
			content: { text: "Same text", source: "chat" },
			embedding: [1],
		});
		const first = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		await stageEvaluatorOutput(runtime, first, {});
		await commitEvaluatorProgress(runtime, first);
		const refresh = {
			...trigger,
			content: { source: "chat", text: "Same text" },
			embedding: [2, 3],
			similarity: 0.4,
		};
		const next = selected(
			await prepareEvaluatorProgress(runtime, refresh, ["facts"], [refresh]),
		);
		expect(next.messages).toEqual([]);
	});

	it("restores frozen output and original trigger after restart while later arrivals stay pending", async () => {
		const firstRuntime = runtimeWith();
		const original = memory("original", "Original assessed request");
		const first = selected(
			await prepareEvaluatorProgress(
				firstRuntime.runtime,
				original,
				["facts"],
				[original],
			),
		);
		const output = { facts: [{ text: "A fact from the original turn" }] };
		await stageEvaluatorOutput(firstRuntime.runtime, first, output);
		output.facts[0].text = "Caller changed its object";
		const restarted = runtimeWith(firstRuntime.store);
		const newer = memory("newer", "Different request", { createdAt: 200 });
		const replay = selected(
			await prepareEvaluatorProgress(
				restarted.runtime,
				newer,
				["facts"],
				[original, newer],
			),
		);
		expect(replay.evidenceId).toBe(first.evidenceId);
		expect(replay.pendingOutput).toEqual({
			facts: [{ text: "A fact from the original turn" }],
		});
		expect(replay.messages.map((row) => row.id)).toEqual(["original"]);
		expect(replay.triggerMessage.id).toBe("original");
		await commitEvaluatorProgress(restarted.runtime, replay);
		const next = selected(
			await prepareEvaluatorProgress(
				restarted.runtime,
				newer,
				["facts"],
				[original, newer],
			),
		);
		expect(next.messages.map((row) => row.id)).toEqual(["newer"]);
		expect(next.triggerMessage.id).toBe("newer");
	});

	it.each(["edited", "deleted"])(
		"holds a %s pending source before any replay writes",
		async (change) => {
			const { runtime, setCache } = runtimeWith();
			const source = memory("source", "Captured source");
			const trigger = memory("trigger", "Original request");
			const first = selected(
				await prepareEvaluatorProgress(
					runtime,
					trigger,
					["facts"],
					[source, trigger],
				),
			);
			await stageEvaluatorOutput(runtime, first, {});
			const newer = memory("newer", "New request");
			const rows =
				change === "edited"
					? [{ ...source, content: { text: "Changed" } }, trigger, newer]
					: [trigger, newer];
			await expect(
				prepareEvaluatorProgress(runtime, newer, ["facts"], rows),
			).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_STALE_EVIDENCE" });
			expect(setCache).toHaveBeenCalledTimes(1);
		},
	);

	it("leaves edits to non-batch historical rows pending after replay", async () => {
		const { runtime } = runtimeWith();
		const historical = memory("historical", "Prior fact");
		const initial = selected(
			await prepareEvaluatorProgress(
				runtime,
				historical,
				["facts"],
				[historical],
			),
		);
		await stageEvaluatorOutput(runtime, initial, {});
		await commitEvaluatorProgress(runtime, initial);
		const trigger = memory("trigger", "New fact");
		const batch = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[historical, trigger],
			),
		);
		await stageEvaluatorOutput(runtime, batch, {});
		const edited = { ...historical, content: { text: "Corrected prior fact" } };
		const replay = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[edited, trigger],
			),
		);
		expect(replay.evidenceId).toBe(batch.evidenceId);
		await commitEvaluatorProgress(runtime, replay);
		const next = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[edited, trigger],
			),
		);
		expect(next.changedMessageIds).toEqual(["historical"]);
	});

	it("holds restoration of a removal captured by staged output", async () => {
		const { runtime } = runtimeWith();
		const old = memory("old", "Removed source");
		const trigger = memory("trigger", "Current request");
		const first = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[old, trigger],
			),
		);
		await stageEvaluatorOutput(runtime, first, {});
		await commitEvaluatorProgress(runtime, first);
		const removal = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		await stageEvaluatorOutput(runtime, removal, {});
		await expect(
			prepareEvaluatorProgress(runtime, trigger, ["facts"], [old, trigger]),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_STALE_EVIDENCE" });
	});

	it("isolates progress by evaluator, author, room and agent even with a shared cache", async () => {
		const { runtime, store } = runtimeWith();
		const trigger = memory("trigger", "Owner fact");
		const snapshots = await prepareEvaluatorProgress(
			runtime,
			trigger,
			["facts", "preferences"],
			[trigger],
		);
		await stageEvaluatorOutput(runtime, selected(snapshots), {});
		await commitEvaluatorProgress(runtime, selected(snapshots));
		expect(
			selected(
				await prepareEvaluatorProgress(
					runtime,
					trigger,
					["preferences"],
					[trigger],
				),
				"preferences",
			).messages,
		).toHaveLength(1);
		const otherAuthor = memory("other-author", "Another person's request", {
			entityId: OTHER,
		});
		expect(
			selected(
				await prepareEvaluatorProgress(
					runtime,
					otherAuthor,
					["facts"],
					[trigger, otherAuthor],
				),
			).messages,
		).toHaveLength(2);
		const otherRoom = { ...trigger, roomId: OTHER };
		expect(
			selected(
				await prepareEvaluatorProgress(
					runtime,
					otherRoom,
					["facts"],
					[otherRoom],
				),
			).messages,
		).toHaveLength(1);
		const otherAgent = runtimeWith(store, OTHER).runtime;
		const theirTrigger = { ...trigger, agentId: OTHER };
		expect(
			selected(
				await prepareEvaluatorProgress(
					otherAgent,
					theirTrigger,
					["facts"],
					[theirTrigger],
				),
			).messages,
		).toHaveLength(1);
	});

	it("does not advance progress when only one of two evaluators succeeds", async () => {
		const { runtime } = runtimeWith();
		const trigger = memory("trigger", "One source");
		const snapshots = await prepareEvaluatorProgress(
			runtime,
			trigger,
			["facts", "preferences"],
			[trigger],
		);
		await stageEvaluatorOutput(runtime, selected(snapshots), {});
		await commitEvaluatorProgress(runtime, selected(snapshots));
		await stageEvaluatorOutput(runtime, selected(snapshots, "preferences"), {
			preferences: [],
		});
		const next = await prepareEvaluatorProgress(
			runtime,
			trigger,
			["facts", "preferences"],
			[trigger],
		);
		expect(selected(next).messages).toEqual([]);
		expect(selected(next, "preferences").pendingOutput).toEqual({
			preferences: [],
		});
	});

	it("propagates failed checkpoint reads rather than treating failure as empty history", async () => {
		const { runtime, getCache } = runtimeWith();
		const trigger = memory("trigger", "Fact");
		getCache.mockRejectedValueOnce(new Error("Read failed"));
		await expect(
			prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		).rejects.toThrow("Read failed");
	});

	it.each(["false", "throw"])(
		"keeps work retryable when staging returns %s",
		async (failure) => {
			const { runtime, setCache, store } = runtimeWith();
			const trigger = memory("trigger", "Fact");
			const snapshot = selected(
				await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
			);
			if (failure === "false") setCache.mockResolvedValueOnce(false);
			else setCache.mockRejectedValueOnce(new Error("Write failed"));
			await expect(
				stageEvaluatorOutput(runtime, snapshot, {}),
			).rejects.toThrow();
			expect(store.size).toBe(0);
			const retry = selected(
				await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
			);
			expect(retry.messages).toHaveLength(1);
			expect(retry.pendingOutput).toBeUndefined();
		},
	);

	it.each(["false", "throw"])(
		"keeps staged output recoverable when commit returns %s",
		async (failure) => {
			const { runtime, setCache } = runtimeWith();
			const trigger = memory("trigger", "Fact");
			const snapshot = selected(
				await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
			);
			await stageEvaluatorOutput(runtime, snapshot, {
				facts: ["already applied"],
			});
			if (failure === "false") setCache.mockResolvedValueOnce(false);
			else setCache.mockRejectedValueOnce(new Error("Commit failed"));
			await expect(
				commitEvaluatorProgress(runtime, snapshot),
			).rejects.toThrow();
			const retry = selected(
				await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
			);
			expect(retry.evidenceId).toBe(snapshot.evidenceId);
			expect(retry.pendingOutput).toEqual({ facts: ["already applied"] });
		},
	);

	it("rejects overlapping writes and replacement of a staged model result", async () => {
		const { runtime } = runtimeWith();
		const trigger = memory("trigger", "Fact");
		const first = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		const overlap = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		await stageEvaluatorOutput(runtime, first, { facts: ["original"] });
		await expect(
			stageEvaluatorOutput(runtime, overlap, {}),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_CONFLICT" });
		await expect(
			stageEvaluatorOutput(runtime, first, { facts: ["replacement"] }),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_CONFLICT" });
	});

	it("fails closed on corrupt checkpoints or malformed/incomplete source snapshots", async () => {
		const { runtime, store } = runtimeWith();
		const trigger = memory("trigger", "Fact");
		await expect(
			prepareEvaluatorProgress(
				runtime,
				{ ...trigger, id: undefined },
				["facts"],
				[trigger],
			),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_INVALID_SOURCE" });
		await expect(
			prepareEvaluatorProgress(runtime, trigger, ["facts"], []),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_INVALID_SOURCE" });
		await expect(
			prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger, trigger]),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_INVALID_SOURCE" });
		await expect(
			prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[trigger, memory("foreign", "private", { roomId: OTHER })],
			),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_INVALID_SOURCE" });
		const snapshot = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		await stageEvaluatorOutput(runtime, snapshot, {});
		const key = [...store.keys()][0];
		store.set(key, { version: "bad" });
		await expect(
			prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		).rejects.toMatchObject({ code: "EVALUATOR_PROGRESS_INVALID_CHECKPOINT" });
	});

	it("does not leak edited/deleted source IDs from the shared add-only guard", () => {
		expect(() => assertExtractionSourcesUnchanged(undefined)).not.toThrow();
		expect(() =>
			assertExtractionSourcesUnchanged({
				isBackfill: false,
				messages: [],
				sourceRevisions: {},
				changedMessageIds: [],
				removedMessageIds: [],
				evidenceId: "batch",
			}),
		).not.toThrow();
		try {
			assertExtractionSourcesUnchanged({
				isBackfill: false,
				messages: [],
				sourceRevisions: {},
				changedMessageIds: ["private-id"],
				removedMessageIds: ["removed-id"],
				evidenceId: "batch",
			});
			throw new Error("Expected source review guard");
		} catch (error) {
			expect(error).toMatchObject({
				code: "EVALUATOR_SOURCE_REVIEW_REQUIRED",
				context: { changedCount: 1, removedCount: 1 },
			});
			expect(JSON.stringify(error)).not.toContain("private-id");
		}
	});

	it("persists only source IDs/revisions, then reconstructs full pending evidence from authoritative history", async () => {
		const { runtime, store } = runtimeWith();
		const trigger = memory(
			"trigger",
			"PRIVATE RAW BODY NEVER DUPLICATED INTO CHECKPOINT",
		);
		const snapshot = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		await stageEvaluatorOutput(runtime, snapshot, { facts: [] });
		const persisted = JSON.stringify([...store.values()]);
		expect(persisted).not.toContain(trigger.content.text);
		expect(persisted).not.toContain('"messages"');
		const restarted = runtimeWith(store).runtime;
		const restored = selected(
			await prepareEvaluatorProgress(restarted, trigger, ["facts"], [trigger]),
		);
		expect(restored.messages[0].content.text).toBe(trigger.content.text);
		expect(restored.triggerMessage).toEqual(trigger);
		expect(restored.isBackfill).toBe(true);
		expect(restored.evidenceId).toBe(snapshot.evidenceId);
	});

	it.each(["edit", "delete"])(
		"rejects a source %s during model generation before staging output",
		async (mutation) => {
			const { runtime, store, getMemories } = runtimeWith();
			const trigger = memory("trigger", "Original private message");
			const snapshot = selected(
				await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
			);
			getMemories.mockResolvedValue(
				mutation === "delete" ? [] : [memory("trigger", "Edited message")],
			);
			await expect(
				stageEvaluatorOutput(runtime, snapshot, {}),
			).rejects.toMatchObject({
				code: "EVALUATOR_PROGRESS_STALE_EVIDENCE",
			});
			expect(store.size).toBe(0);
			expect(getMemories).toHaveBeenCalledWith({
				tableName: "messages",
				roomId: ROOM,
				agentId: AGENT,
				unique: false,
				orderDirection: "asc",
				includeEmbedding: false,
			});
		},
	);

	it("rechecks evidence after reducers and holds the staged batch on a concurrent edit", async () => {
		const { runtime, store, getMemories } = runtimeWith();
		const trigger = memory("trigger", "Original message");
		const snapshot = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		await stageEvaluatorOutput(runtime, snapshot, { facts: [] });
		const staged = structuredClone([...store.values()]);
		getMemories.mockResolvedValue([
			memory("trigger", "Changed while reducers ran"),
		]);
		await expect(
			commitEvaluatorProgress(runtime, snapshot),
		).rejects.toMatchObject({
			code: "EVALUATOR_PROGRESS_STALE_EVIDENCE",
		});
		expect([...store.values()]).toEqual(staged);
		await expect(
			prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[memory("trigger", "Changed while reducers ran")],
			),
		).rejects.toMatchObject({
			code: "EVALUATOR_PROGRESS_STALE_EVIDENCE",
		});
	});

	it("validates fresh rows even when replaying the same previously staged output", async () => {
		const { runtime, store } = runtimeWith();
		const trigger = memory("trigger", "Original message");
		const snapshot = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		await stageEvaluatorOutput(runtime, snapshot, { facts: [] });
		const restarted = runtimeWith(store);
		const replay = selected(
			await prepareEvaluatorProgress(
				restarted.runtime,
				trigger,
				["facts"],
				[trigger],
			),
		);
		restarted.getMemories.mockResolvedValue([]);
		await expect(
			stageEvaluatorOutput(restarted.runtime, replay, replay.pendingOutput),
		).rejects.toMatchObject({
			code: "EVALUATOR_PROGRESS_STALE_EVIDENCE",
		});
	});

	it("ignores derived topics/trajectory/session usage but preserves authored metadata and attachments", async () => {
		const { runtime, getMemories } = runtimeWith();
		const trigger = memory("trigger", "Original message");
		const snapshot = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		const bookkeeping = memory("trigger", "Original message", {
			content: {
				text: "Original message",
				chatIdempotency: {
					version: 1,
					clientMessageId: "delivery",
					outcome: { status: "complete" },
				},
			},
			metadata: {
				topics: ["generated-topic"],
				trajectoryId: "trace",
				trajectoryStepId: "step",
				evaluatedAt: 12,
				embeddingUpdatedAt: 19,
				session: { updatedAt: 20, usage: { inputTokens: 123 } },
			},
		});
		getMemories.mockResolvedValue([bookkeeping]);
		await stageEvaluatorOutput(runtime, snapshot, {});
		await commitEvaluatorProgress(runtime, snapshot);
		const unchanged = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[bookkeeping],
			),
		);
		expect(unchanged.messages).toEqual([]);
		const privacyEdit = {
			...bookkeeping,
			metadata: { ...bookkeeping.metadata, scope: "private" },
		} as Memory;
		const changed = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[privacyEdit],
			),
		);
		expect(changed.changedMessageIds).toEqual([trigger.id]);
		const attachmentEdit = {
			...bookkeeping,
			content: {
				...bookkeeping.content,
				attachments: [
					{ id: "asset", url: "https://example.test/new", title: "changed" },
				],
			},
		} as Memory;
		const changedAttachment = selected(
			await prepareEvaluatorProgress(
				runtime,
				trigger,
				["facts"],
				[attachmentEdit],
			),
		);
		expect(changedAttachment.changedMessageIds).toEqual([trigger.id]);
	});

	it("propagates authoritative source read failures without staging or acknowledging work", async () => {
		const { runtime, store, getMemories } = runtimeWith();
		const trigger = memory("trigger", "Original message");
		const snapshot = selected(
			await prepareEvaluatorProgress(runtime, trigger, ["facts"], [trigger]),
		);
		getMemories.mockRejectedValue(new Error("source database unavailable"));
		await expect(stageEvaluatorOutput(runtime, snapshot, {})).rejects.toThrow(
			"source database unavailable",
		);
		expect(store.size).toBe(0);
	});
});
