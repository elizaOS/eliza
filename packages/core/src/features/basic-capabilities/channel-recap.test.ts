/**
 * Deterministic unit tests for the CHANNEL_RECAP room-history action: general-
 * context reachability through the exposure gate (with the ADMIN messaging
 * search excluded from the same surface), structural room scoping (a message
 * from room A can never surface room B content, even when the planner passes
 * room-selector-shaped parameters), complete untruncated transcript content in
 * chronological order, the caller-requested count contract with its documented
 * storage read bound, and machinery-row filtering. Runtime is a vi.fn stub —
 * no model, no database.
 */
import { describe, expect, it, vi } from "vitest";
import { filterByContextGate } from "../../runtime/context-gates.ts";
import type { IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import { searchMessagesAction } from "../messaging/triage/actions/searchMessages.ts";
import {
	CHANNEL_RECAP_MAX_FETCH,
	channelRecapAction,
} from "./actions/channel-recap.ts";
import { basicActions } from "./index.ts";

const AGENT_ID = "00000000-0000-4000-8000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-4000-8000-00000000c0de" as UUID;
const ROOM_A = "00000000-0000-4000-8000-00000000aaaa" as UUID;
const ROOM_B = "00000000-0000-4000-8000-00000000bbbb" as UUID;

function makeMessage(
	roomId: UUID,
	createdAt: number,
	text: string,
	extra: Partial<Memory> = {},
): Memory {
	return {
		id: `00000000-0000-4000-8000-${String(createdAt).padStart(12, "0")}` as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId,
		createdAt,
		content: { text, source: "discord" },
		...extra,
	} as Memory;
}

interface RuntimeStub {
	runtime: IAgentRuntime;
	getMemories: ReturnType<typeof vi.fn>;
}

function makeRuntime(fixtures: Record<string, Memory[]>): RuntimeStub {
	const getMemories = vi.fn(
		async (params: { roomId?: UUID; count?: number; limit?: number }) => {
			const rows = (fixtures[params.roomId ?? ""] ?? [])
				.slice()
				.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
			const limit = params.limit ?? params.count ?? Number.POSITIVE_INFINITY;
			return rows.slice(0, limit);
		},
	);
	const runtime = {
		agentId: AGENT_ID,
		getMemories,
		getRoom: vi.fn(async (roomId: UUID) => ({
			id: roomId,
			source: "discord",
		})),
		getEntitiesForRoom: vi.fn(async () => [
			{ id: USER_ID, agentId: AGENT_ID, names: ["Al"], metadata: {} },
		]),
	} as unknown as IAgentRuntime;
	return { runtime, getMemories };
}

const incoming = (roomId: UUID): Memory =>
	makeMessage(roomId, 9_999_000, "what were the last 100 messages here?");

describe("CHANNEL_RECAP registration and general-context reachability", () => {
	it("is part of the basic action bundle", () => {
		expect(basicActions.map((action) => action.name)).toContain(
			"CHANNEL_RECAP",
		);
	});

	it("declares exactly the general context", () => {
		expect(channelRecapAction.contexts).toEqual(["general"]);
	});

	it("passes the exposure gate for a general-context group sender while the messaging search stays out", () => {
		const surfaced = filterByContextGate(
			[channelRecapAction, searchMessagesAction],
			["general"],
			["GUEST"],
		);
		expect(surfaced.map((action) => action.name)).toEqual(["CHANNEL_RECAP"]);

		// Even an ADMIN in a general-routed turn does not get the cross-channel
		// search: its contexts stay messaging/email/documents.
		const adminSurfaced = filterByContextGate(
			[searchMessagesAction],
			["general"],
			["ADMIN"],
		);
		expect(adminSurfaced).toEqual([]);
	});

	it("validate accepts a routed turn (general is always in the active set)", async () => {
		const message = incoming(ROOM_A);
		message.content = {
			...message.content,
			metadata: {
				__responseContext: { primaryContext: "general" },
			},
		};
		await expect(
			channelRecapAction.validate(makeRuntime({}).runtime, message, undefined),
		).resolves.toBe(true);
	});
});

describe("CHANNEL_RECAP room scoping", () => {
	const fixtures = {
		[ROOM_A]: [
			makeMessage(ROOM_A, 1_000, "alpha one"),
			makeMessage(ROOM_A, 2_000, "alpha two"),
		],
		[ROOM_B]: [makeMessage(ROOM_B, 1_500, "bravo secret")],
	};

	it("returns only the sender's current room, never another room", async () => {
		const { runtime, getMemories } = makeRuntime(fixtures);
		const result = await channelRecapAction.handler(
			runtime,
			incoming(ROOM_A),
			undefined,
			undefined,
		);
		expect(result.success).toBe(true);
		expect(result.text).toContain("alpha one");
		expect(result.text).toContain("alpha two");
		expect(result.text).not.toContain("bravo secret");
		expect(getMemories).toHaveBeenCalledWith(
			expect.objectContaining({ roomId: ROOM_A, tableName: "messages" }),
		);
		const scope = (result.data as { scope: { roomId?: string } }).scope;
		expect(scope).toMatchObject({ roomScoped: true });
		expect((result.data as { roomId: string }).roomId).toBe(ROOM_A);
	});

	it("ignores room-selector-shaped parameters: scoping is structural", async () => {
		const { runtime, getMemories } = makeRuntime(fixtures);
		const result = await channelRecapAction.handler(
			runtime,
			incoming(ROOM_A),
			undefined,
			{
				parameters: {
					roomId: ROOM_B,
					channelId: ROOM_B,
					roomIds: [ROOM_B],
					worldId: ROOM_B,
				},
			},
		);
		expect(result.success).toBe(true);
		expect(result.text).not.toContain("bravo secret");
		expect(result.text).toContain("alpha one");
		for (const call of getMemories.mock.calls) {
			expect(call[0].roomId).toBe(ROOM_A);
		}
	});

	it("fails typed when the message has no roomId", async () => {
		const { runtime } = makeRuntime(fixtures);
		const message = incoming(ROOM_A);
		(message as { roomId?: UUID }).roomId = undefined;
		const result = await channelRecapAction.handler(
			runtime,
			message,
			undefined,
			undefined,
		);
		expect(result.success).toBe(false);
		expect(result.text).toContain("roomId");
	});
});

describe("CHANNEL_RECAP transcript completeness and order", () => {
	it("renders every message complete — no truncation of long content", async () => {
		const longText = `${"the quarterly numbers were discussed at length ".repeat(200)}FINAL_MARKER_END`;
		const { runtime } = makeRuntime({
			[ROOM_A]: [makeMessage(ROOM_A, 1_000, longText)],
		});
		const result = await channelRecapAction.handler(
			runtime,
			incoming(ROOM_A),
			undefined,
			undefined,
		);
		expect(result.text).toContain(longText);
		const data = result.data as {
			messages: Array<{ text: string }>;
		};
		expect(data.messages[0].text).toBe(longText);
	});

	it("renders chronologically, oldest first", async () => {
		const { runtime } = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 3_000, "third message"),
				makeMessage(ROOM_A, 1_000, "first message"),
				makeMessage(ROOM_A, 2_000, "second message"),
			],
		});
		const result = await channelRecapAction.handler(
			runtime,
			incoming(ROOM_A),
			undefined,
			undefined,
		);
		const text = result.text ?? "";
		expect(text.indexOf("first message")).toBeGreaterThan(-1);
		expect(text.indexOf("first message")).toBeLessThan(
			text.indexOf("second message"),
		);
		expect(text.indexOf("second message")).toBeLessThan(
			text.indexOf("third message"),
		);
		const data = result.data as {
			messages: Array<{ createdAt: number | null }>;
		};
		expect(data.messages.map((m) => m.createdAt)).toEqual([
			1_000, 2_000, 3_000,
		]);
	});

	it("strips only machinery rows (action results, internal bridge relays)", async () => {
		const { runtime } = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "human line"),
				makeMessage(ROOM_A, 2_000, "tool record", {
					content: { type: "action_result", text: "tool record" },
				} as Partial<Memory>),
				makeMessage(ROOM_A, 3_000, "bridge relay", {
					content: { text: "bridge relay", source: "swarm_synthesis" },
				} as Partial<Memory>),
			],
		});
		const result = await channelRecapAction.handler(
			runtime,
			incoming(ROOM_A),
			undefined,
			undefined,
		);
		expect(result.text).toContain("human line");
		expect(result.text).not.toContain("tool record");
		expect(result.text).not.toContain("bridge relay");
		expect(result.values?.messageCount).toBe(1);
	});

	it("filters machinery before satisfying the requested dialogue count", async () => {
		const machinery = Array.from({ length: 60 }, (_, index) =>
			makeMessage(ROOM_A, 10_000 + index, `tool-${index}`, {
				content: { type: "action_result", text: `tool-${index}` },
			} as Partial<Memory>),
		);
		const { runtime } = makeRuntime({
			[ROOM_A]: [
				makeMessage(ROOM_A, 1_000, "older dialogue one"),
				makeMessage(ROOM_A, 2_000, "older dialogue two"),
				...machinery,
			],
		});
		const result = await channelRecapAction.handler(
			runtime,
			incoming(ROOM_A),
			undefined,
			{ parameters: { count: 2 } },
		);
		expect(result.success).toBe(true);
		expect(result.values?.messageCount).toBe(2);
		expect(result.text).toContain("older dialogue one");
		expect(result.text).toContain("older dialogue two");
	});
});

describe("CHANNEL_RECAP count contract", () => {
	const many = Array.from({ length: 10 }, (_, index) =>
		makeMessage(ROOM_A, (index + 1) * 1_000, `msg-${index + 1}`),
	);

	it("defaults to the documented default count", async () => {
		const { runtime, getMemories } = makeRuntime({ [ROOM_A]: many });
		await channelRecapAction.handler(
			runtime,
			incoming(ROOM_A),
			undefined,
			undefined,
		);
		expect(getMemories).toHaveBeenCalledWith(
			expect.objectContaining({ count: CHANNEL_RECAP_MAX_FETCH }),
		);
	});

	it("honors an explicit caller-requested count, including numeric strings", async () => {
		const { runtime, getMemories } = makeRuntime({ [ROOM_A]: many });
		await channelRecapAction.handler(runtime, incoming(ROOM_A), undefined, {
			parameters: { count: 100 },
		});
		expect(getMemories).toHaveBeenLastCalledWith(
			expect.objectContaining({ count: CHANNEL_RECAP_MAX_FETCH }),
		);
		await channelRecapAction.handler(runtime, incoming(ROOM_A), undefined, {
			parameters: { count: "25" },
		});
		expect(getMemories).toHaveBeenLastCalledWith(
			expect.objectContaining({ count: CHANNEL_RECAP_MAX_FETCH }),
		);
	});

	it("rejects requests above the storage bound without a partial transcript", async () => {
		const { runtime, getMemories } = makeRuntime({ [ROOM_A]: many });
		const result = await channelRecapAction.handler(
			runtime,
			incoming(ROOM_A),
			undefined,
			{ parameters: { count: 100_000 } },
		);
		expect(getMemories).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.text).toContain(String(CHANNEL_RECAP_MAX_FETCH));
		expect(result.text).toContain("storage read bound");
		expect((result.data as { error: string }).error).toBe(
			"CHANNEL_RECAP_COUNT_TOO_LARGE",
		);
	});

	it("falls back to the default for non-positive or malformed counts", async () => {
		const { runtime, getMemories } = makeRuntime({ [ROOM_A]: many });
		for (const bad of [0, -5, "not-a-number", null]) {
			await channelRecapAction.handler(runtime, incoming(ROOM_A), undefined, {
				parameters: { count: bad },
			});
			expect(getMemories).toHaveBeenLastCalledWith(
				expect.objectContaining({ count: CHANNEL_RECAP_MAX_FETCH }),
			);
		}
	});
});

describe("CHANNEL_RECAP complete transcript and offset paging", () => {
	const ROOM = "00000000-0000-4000-8000-00000000f1f1" as UUID;

	it("serves the entire requested range even when it is large", async () => {
		const rows = Array.from({ length: 20 }, (_, i) =>
			makeMessage(ROOM, 1_000 + i, `M${i}-${"x".repeat(9_000)}`),
		);
		const { runtime } = makeRuntime({ [ROOM]: rows });
		const result = (await channelRecapAction.handler(
			runtime,
			incoming(ROOM),
			undefined,
			{ parameters: { count: 20 } },
		)) as ActionResult;
		expect(result.success).toBe(true);
		const scope = (result.data as { scope: Record<string, unknown> }).scope;
		expect(scope.renderedCount).toBe(20);
		for (let i = 0; i < 20; i++) {
			expect(result.text).toContain(`M${i}-${"x".repeat(9_000)}`);
		}
	});

	it("offset pages into older history and reports the exact range", async () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			makeMessage(ROOM, 1_000 + i, `msg-${i}`),
		);
		const { runtime } = makeRuntime({ [ROOM]: rows });
		const result = (await channelRecapAction.handler(
			runtime,
			incoming(ROOM),
			undefined,
			{ parameters: { count: 4, offset: 4 } },
		)) as ActionResult;
		expect(result.success).toBe(true);
		// newest-first rows: offset 4 skips msg-11..msg-8; serves msg-7..msg-4.
		for (const i of [7, 6, 5, 4]) expect(result.text).toContain(`msg-${i}`);
		for (const i of [11, 10, 9, 8, 3]) {
			expect(result.text).not.toContain(`msg-${i}\n`);
		}
		expect(result.text).toContain("messages 5–8 back");
	});

	it("serves every requested message complete without a text-fit slice", async () => {
		const giant = "G".repeat(65_000);
		const rows = [
			makeMessage(ROOM, 1_000, "older small"),
			makeMessage(ROOM, 2_000, giant),
		];
		const { runtime } = makeRuntime({ [ROOM]: rows });
		const result = (await channelRecapAction.handler(
			runtime,
			incoming(ROOM),
			undefined,
			{ parameters: { count: 2 } },
		)) as ActionResult;
		expect(result.success).toBe(true);
		expect(result.text).toContain(giant);
		const scope = (result.data as { scope: Record<string, unknown> }).scope;
		expect(scope.renderedCount).toBe(2);
		expect(result.text).toContain("older small");
	});
});
