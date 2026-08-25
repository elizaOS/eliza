/**
 * Ordering contract for the RECENT_MESSAGES dialogue window: the transcript the
 * prompt renders must stay chronological (oldest first) and must stay
 * deterministic when an adapter row carries a non-finite `createdAt`.
 * Deterministic — drives the real `recentMessagesProvider.get` against a
 * hand-built in-memory runtime of `vi.fn` stubs; no live model or database.
 */

import { describe, expect, it, vi } from "vitest";

const revalidateOwnerExclusiveDisclosure = vi.hoisted(() =>
	vi.fn(async () => ({
		allowed: true as const,
		basis: "owner_private_destination" as const,
	})),
);

vi.mock(
	"../../../security/trusted-delivery-audience.ts",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../security/trusted-delivery-audience.ts")
			>();
		return {
			...actual,
			revalidateOwnerExclusiveDisclosure,
			markOwnerExclusiveDisclosureUsed: vi.fn(),
			recordOwnerExclusiveSuppression: vi.fn(),
		};
	},
);

import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
} from "../../../types/index.ts";
import { recentMessagesProvider } from "./recentMessages.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-000000000002";
const USER_ID = "00000000-0000-0000-0000-000000000003";

function makeMemory(
	id: string,
	entityId: string,
	text: string,
	createdAt: number,
): Memory {
	return {
		id,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		entityId,
		createdAt,
		content: { text, source: "discord" },
	} as Memory;
}

function makeRuntime(memories: Memory[]): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "Agent" },
		getConversationLength: vi.fn(() => 10),
		getRoom: vi.fn(async () => ({
			id: ROOM_ID,
			type: ChannelType.GROUP,
			source: "discord",
			metadata: {},
		})),
		getEntitiesForRoom: vi.fn(async () => [
			{ id: AGENT_ID, agentId: AGENT_ID, names: ["Agent"], components: [] },
			{ id: USER_ID, agentId: AGENT_ID, names: ["User"], components: [] },
		]),
		getEntityById: vi.fn(async () => null),
		getMemories: vi.fn(async () => memories),
		getRoomsForParticipants: vi.fn(async () => []),
		getRoomsForParticipant: vi.fn(async () => []),
		getMemoriesByRoomIds: vi.fn(async () => []),
		getService: vi.fn(() => null),
	} as unknown as IAgentRuntime;
}

async function dialogueIds(memories: Memory[]): Promise<string[]> {
	const result = await recentMessagesProvider.get(
		makeRuntime(memories),
		makeMemory("current", USER_ID, "next task", 9000),
		{ values: {}, data: {}, text: "" },
	);
	const rows = (result.data?.recentMessages ?? []) as Memory[];
	return rows.map((row) => String(row.id));
}

describe("recentMessagesProvider dialogue ordering", () => {
	it("renders history oldest-first regardless of storage order", async () => {
		const ids = await dialogueIds([
			makeMemory("msg-c", USER_ID, "third", 3000),
			makeMemory("msg-a", USER_ID, "first", 1000),
			makeMemory("msg-b", AGENT_ID, "second", 2000),
		]);

		expect(ids).toEqual(["msg-a", "msg-b", "msg-c"]);
	});

	// `formatMessages` walks the array from the end, so an ascending window
	// renders newest-first. Flipping the sort to descending silently inverts the
	// model-facing transcript; this pins the rendered direction.
	it("renders the model-facing transcript newest-first", async () => {
		const result = await recentMessagesProvider.get(
			makeRuntime([
				makeMemory("msg-c", USER_ID, "third", 3000),
				makeMemory("msg-a", USER_ID, "first", 1000),
				makeMemory("msg-b", AGENT_ID, "second", 2000),
			]),
			makeMemory("current", USER_ID, "next task", 9000),
			{ values: {}, data: {}, text: "" },
		);

		const text = String(result.values?.recentMessages ?? "");
		const firstAt = text.indexOf("first");
		const secondAt = text.indexOf("second");
		const thirdAt = text.indexOf("third");
		expect(thirdAt).toBeGreaterThanOrEqual(0);
		expect(thirdAt).toBeLessThan(secondAt);
		expect(secondAt).toBeLessThan(firstAt);
	});

	it("sorts a non-finite createdAt as oldest instead of leaving it in place", async () => {
		const ids = await dialogueIds([
			makeMemory("msg-a", USER_ID, "first", 1000),
			makeMemory("msg-b", AGENT_ID, "second", 2000),
			makeMemory("msg-nan", USER_ID, "broken timestamp", Number.NaN),
		]);

		expect(ids).toEqual(["msg-nan", "msg-a", "msg-b"]);
	});

	it("breaks exact createdAt ties deterministically on id", async () => {
		const forward = await dialogueIds([
			makeMemory("msg-z", USER_ID, "zulu", 1000),
			makeMemory("msg-a", AGENT_ID, "alpha", 1000),
		]);
		const reversed = await dialogueIds([
			makeMemory("msg-a", AGENT_ID, "alpha", 1000),
			makeMemory("msg-z", USER_ID, "zulu", 1000),
		]);

		expect(forward).toEqual(["msg-a", "msg-z"]);
		expect(reversed).toEqual(["msg-a", "msg-z"]);
	});
});
