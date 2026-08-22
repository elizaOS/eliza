/**
 * Exercises MESSAGE's real stored-memory read branch with deterministic runtime
 * doubles. The tests pin byte-exact continuation, live authorization, stale
 * revision rejection, Unicode boundaries, and the single-carrier prompt shape.
 */

import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	ReadView,
	UUID,
} from "../../../types/index.ts";
import { messageAction } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const REQUESTER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const OTHER_ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const MEMORY_ID = "00000000-0000-0000-0000-000000000005" as UUID;

const deliveryMessage = {
	id: "00000000-0000-0000-0000-000000000006" as UUID,
	roomId: ROOM_ID,
	entityId: REQUESTER_ID,
	agentId: AGENT_ID,
	content: { text: "read the stored message", source: "discord" },
	createdAt: 1,
} as Memory;

function storedMemory(text: string, roomId: UUID = ROOM_ID): Memory {
	return {
		id: MEMORY_ID,
		roomId,
		entityId: REQUESTER_ID,
		agentId: AGENT_ID,
		content: { text, source: "discord" },
		metadata: { scope: "room" },
		createdAt: 1,
	} as Memory;
}

function runtimeFor(
	getMemoryById: IAgentRuntime["getMemoryById"],
	getParticipantsForRoom: IAgentRuntime["getParticipantsForRoom"] = async () => [
		REQUESTER_ID,
	],
): IAgentRuntime {
	return createMockRuntime({
		agentId: AGENT_ID,
		getMemoryById,
		getParticipantsForRoom,
	});
}

async function read(
	runtime: IAgentRuntime,
	parameters: Record<string, unknown>,
): Promise<ActionResult> {
	const locator =
		typeof parameters.reference === "string"
			? { reference: parameters.reference }
			: { messageId: MEMORY_ID };
	const result = await messageAction.handler(
		runtime,
		deliveryMessage,
		undefined,
		{
			parameters: {
				action: "read_channel",
				...locator,
				...parameters,
			},
		},
		undefined,
		undefined,
	);
	if (!result) throw new Error("MESSAGE handler returned no result");
	return result;
}

function view(result: ActionResult): ReadView {
	return (result.data as { readView: ReadView }).readView;
}

describe("MESSAGE stored-memory progressive read", () => {
	it("reaches late evidence in a large memory through exact half-open pages", async () => {
		const canary = "LATE-EVIDENCE-9f32";
		const source = `${"a".repeat(1024 * 1024)}${canary}`;
		const runtime = runtimeFor(async () => storedMemory(source));
		const first = await read(runtime, { limit: 4096 });
		expect(first.success).toBe(true);
		expect(first.text).toBe("a".repeat(4096));
		expect(first.text).not.toContain(canary);
		expect(view(first).slice.range).toEqual({
			unit: "byte",
			start: 0,
			end: 4096,
			total: source.length,
		});

		const late = await read(runtime, {
			reference: view(first).reference.ref,
			offset: source.length - canary.length,
			limit: 64,
			expectedRevision: view(first).slice.revision,
		});
		expect(late.success).toBe(true);
		expect(late.text).toBe(canary);
		expect(view(late).slice.range.end).toBe(source.length);
		expect(view(late).slice.completeness).toBe("complete");
	});

	it("rejects a continuation after the stored content mutates", async () => {
		let current = storedMemory("original content with a later page");
		const getMemoryById = vi.fn(async () => current);
		const runtime = runtimeFor(getMemoryById);
		const first = await read(runtime, { limit: 8 });
		const revision = view(first).slice.revision;
		current = storedMemory("changed content with a later page");

		const stale = await read(runtime, {
			reference: view(first).reference.ref,
			offset: view(first).slice.nextOffset,
			limit: 8,
			expectedRevision: revision,
		});
		expect(stale.success).toBe(false);
		expect((stale.data as { error: string }).error).toBe(
			"MESSAGE_MEMORY_STALE_REVISION",
		);
		expect(stale.text).not.toContain("changed content");
		expect(getMemoryById).toHaveBeenCalledTimes(2);
	});

	it("requires the prior revision for a nonzero continuation", async () => {
		const runtime = runtimeFor(async () =>
			storedMemory("first page then second page"),
		);
		const continuation = await read(runtime, { offset: 5, limit: 5 });
		expect(continuation.success).toBe(false);
		expect((continuation.data as { error: string }).error).toBe(
			"MESSAGE_MEMORY_EXPECTED_REVISION_REQUIRED",
		);
	});

	it("rechecks membership and room containment on every page", async () => {
		let authorized = true;
		const membership = vi.fn(async () => (authorized ? [REQUESTER_ID] : []));
		const runtime = runtimeFor(
			async () => storedMemory("private room body"),
			membership,
		);
		const first = await read(runtime, { limit: 8 });
		expect(first.success).toBe(true);
		authorized = false;
		const revoked = await read(runtime, {
			reference: view(first).reference.ref,
			offset: view(first).slice.nextOffset,
			limit: 8,
			expectedRevision: view(first).slice.revision,
		});
		expect(revoked.success).toBe(false);
		expect((revoked.data as { error: string }).error).toBe(
			"MESSAGE_MEMORY_ACCESS_DENIED",
		);
		expect(membership).toHaveBeenCalledTimes(2);

		const crossRoom = await read(
			runtimeFor(async () => storedMemory("other-room secret", OTHER_ROOM_ID)),
			{ limit: 8 },
		);
		expect(crossRoom.success).toBe(false);
		expect(crossRoom.text).not.toContain("other-room secret");
	});

	it("keeps exact page text out of data and promptData", async () => {
		const source = "UNIQUE-PAGE-BODY-4a77";
		const result = await read(
			runtimeFor(async () => storedMemory(source)),
			{ limit: 64 },
		);
		expect(result.text).toBe(source);
		expect(JSON.stringify(result.data)).not.toContain(source);
		expect(JSON.stringify(result.promptData)).not.toContain(source);
		expect(result.promptData).toEqual(result.data);
	});

	it("pages Unicode without malformed, skipped, or duplicated bytes", async () => {
		const source = "A😀漢éZ";
		const runtime = runtimeFor(async () => storedMemory(source));
		const first = await read(runtime, { offset: 0, limit: 5 });
		expect(first.text).toBe("A😀");
		const second = await read(runtime, {
			reference: view(first).reference.ref,
			offset: view(first).slice.nextOffset,
			limit: 5,
			expectedRevision: view(first).slice.revision,
		});
		const third = await read(runtime, {
			reference: view(second).reference.ref,
			offset: view(second).slice.nextOffset,
			limit: 5,
			expectedRevision: view(second).slice.revision,
		});
		expect(`${first.text}${second.text}${third.text}`).toBe(source);
		for (const result of [first, second, third]) {
			expect(result.text).not.toContain("�");
		}

		const split = await read(runtime, { offset: 2, limit: 5 });
		expect(split.success).toBe(false);
		expect((split.data as { error: string }).error).toBe(
			"MESSAGE_MEMORY_INVALID_RANGE",
		);
	});
});
