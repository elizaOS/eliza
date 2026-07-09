/**
 * Behavioral tests for the RECENT_MESSAGES provider's transcript hygiene:
 * dropping internal bridge / sub-agent / tool / path-dump / synthetic-failure /
 * transient rows, deduping, compaction-ledger inclusion, and the conversation-
 * window cap. Deterministic — drives `recentMessagesProvider.get` against a
 * hand-built in-memory runtime of `vi.fn` stubs; no live model or database.
 */

import { describe, expect, it, vi } from "vitest";
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
	source: string,
	createdAt: number,
	metadata?: Record<string, unknown>,
): Memory {
	return {
		id,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		entityId,
		createdAt,
		content: { text, source, ...(metadata ? { metadata } : {}) },
	} as Memory;
}

function makeRuntime(
	memories: Memory[],
	room: {
		type?: (typeof ChannelType)[keyof typeof ChannelType];
		metadata?: Record<string, unknown>;
		conversationLength?: number;
	} = {},
	overrides: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "Agent" },
		getConversationLength: vi.fn(() => room.conversationLength ?? 10),
		getRoom: vi.fn(async () => ({
			id: ROOM_ID,
			type: room.type ?? ChannelType.GROUP,
			source: "discord",
			metadata: room.metadata ?? {},
		})),
		getEntitiesForRoom: vi.fn(async () => [
			{ id: AGENT_ID, agentId: AGENT_ID, names: ["Agent"], components: [] },
			{ id: USER_ID, agentId: AGENT_ID, names: ["User"], components: [] },
		]),
		getEntityById: vi.fn(async () => null),
		getMemories: vi.fn(async () => memories),
		getRoomsForParticipants: vi.fn(async () => []),
		getMemoriesByRoomIds: vi.fn(async () => []),
		getService: vi.fn(() => null),
		...overrides,
	} as IAgentRuntime;
}

describe("recentMessagesProvider", () => {
	it("omits internal swarm synthesis bridge rows from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "done", "swarm_synthesis", 2000),
			makeMemory("msg-3", AGENT_ID, "done", "discord", 3000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("Agent: done");
		expect(result.text?.match(/Agent: done/g)).toHaveLength(1);
	});

	it("omits prior sub-agent router transcripts from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory(
				"msg-2",
				"00000000-0000-0000-0000-000000000004",
				"[sub-agent: app build (opencode) — task_complete]\n[tool output: list files]\nnoisy transcript",
				"acpx:sub-agent-router",
				2000,
				{ subAgent: true },
			),
			makeMemory("msg-3", AGENT_ID, "https://example.com/app", "discord", 3000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: build the app");
		expect(result.text).toContain("Agent: https://example.com/app");
		expect(result.text).not.toContain("[sub-agent:");
		expect(result.text).not.toContain("noisy transcript");
	});

	it("omits leaked assistant tool transcripts from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory(
				"msg-2",
				AGENT_ID,
				"[tool output: list files]\nsecretly long transcript\n[/tool output]",
				"discord",
				2000,
			),
			makeMemory(
				"msg-3",
				USER_ID,
				"why did [tool output:] show up?",
				"discord",
				3000,
			),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: build the app");
		expect(result.text).toContain("why did [tool output:] show up?");
		expect(result.text).not.toContain("secretly long transcript");
	});

	it("omits leaked assistant local path dumps from dialogue history", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build the app", "discord", 1000),
			makeMemory(
				"msg-2",
				AGENT_ID,
				[
					"/workspace/app/.next/static/chunks/a.js",
					"/workspace/app/.next/static/chunks/b.js",
					"/workspace/app/.git/index",
					"/workspace/app/data/apps/demo/index.html",
					"/workspace/app/data/apps/demo/app.js",
				].join("\n"),
				"discord",
				2000,
			),
			makeMemory(
				"msg-3",
				USER_ID,
				"the app path is /workspace/app",
				"discord",
				3000,
			),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 4000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: build the app");
		expect(result.text).toContain("the app path is /workspace/app");
		expect(result.text).not.toContain(".next/static/chunks");
	});

	it("omits synthetic assistant failure replies from dialogue history", async () => {
		const memories = [
			makeMemory(
				"msg-1",
				USER_ID,
				"I saw a provider issue in the UI",
				"client_chat",
				1000,
			),
			makeMemory(
				"msg-2",
				AGENT_ID,
				"Sorry, I'm having a provider issue",
				"client_chat",
				2000,
			),
			makeMemory(
				"msg-3",
				AGENT_ID,
				"Something went wrong on my end. Please try again.",
				"client_chat",
				3000,
			),
			makeMemory(
				"msg-4",
				AGENT_ID,
				"I can help with the next step.",
				"client_chat",
				4000,
			),
			makeMemory("msg-5", AGENT_ID, "Retrying...", "client_chat", 5000, {
				elizaSyntheticFailure: true,
				chatFailureKind: "provider_issue",
			}),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "client_chat", 6000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: I saw a provider issue in the UI");
		expect(result.text).toContain("Agent: I can help with the next step.");
		expect(result.text).not.toContain("Agent: Sorry");
		expect(result.text).not.toContain("Something went wrong");
		expect(result.text).not.toContain("Retrying...");
	});

	it("dedupes repeated assistant messages within one assistant run", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "build app one", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "On it", "discord", 2000),
			makeMemory(
				"msg-3",
				AGENT_ID,
				"https://example.com/app-one",
				"discord",
				3000,
			),
			makeMemory("msg-4", AGENT_ID, "On it", "discord", 4000),
			makeMemory(
				"msg-5",
				AGENT_ID,
				"https://example.com/app-one",
				"discord",
				5000,
			),
			makeMemory("msg-6", USER_ID, "build app two", "discord", 6000),
			makeMemory("msg-7", AGENT_ID, "On it", "discord", 7000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "status", "discord", 8000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text?.match(/Agent: On it/g)).toHaveLength(2);
		expect(result.text?.match(/https:\/\/example\.com\/app-one/g)).toHaveLength(
			1,
		);
		expect(result.text).toContain("User: build app two");
	});

	it("omits consecutive duplicate dialogue rows from the same sender", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "are you there?", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "yes", "runtime", 2000),
			makeMemory("msg-3", AGENT_ID, " yes ", "discord", 3000),
			makeMemory("msg-4", USER_ID, "next task", "discord", 4000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "status", "discord", 5000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.data?.recentMessages).toHaveLength(3);
		expect(result.text?.match(/Agent: yes/g)).toHaveLength(1);
		expect(result.text).toContain("User: next task");
	});

	it("includes persisted compact ledger even when raw history is not pruned", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "current tail", "discord", 1000),
		];
		const result = await recentMessagesProvider.get(
			makeRuntime(memories, {
				metadata: {
					conversationCompaction: {
						priorLedger:
							"[conversation hybrid-ledger]\nFacts:\n- parcel LIME-4421",
					},
				},
			}),
			makeMemory("current", USER_ID, "status", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("# Conversation Compact Ledger");
		expect(result.text).toContain("LIME-4421");
		expect(result.text).toContain("User: current tail");
	});

	it("includes compact ledger in feed/thread post-format prompts", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "thread post", "discord", 1000),
		];
		const result = await recentMessagesProvider.get(
			makeRuntime(memories, {
				type: ChannelType.THREAD,
				metadata: {
					lastCompactionAt: 999,
					conversationCompaction: {
						priorLedger:
							"[conversation hybrid-ledger]\nFacts:\n- thread code BLUE-77",
					},
				},
			}),
			makeMemory("current", USER_ID, "status", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.values?.recentPosts).toContain(
			"# Conversation Compact Ledger",
		);
		expect(result.text).toContain("BLUE-77");
		expect(result.text).toContain("# Posts in Thread");
	});

	it("omits agent-emitted transient status messages from dialogue history", async () => {
		// Orchestrator marks every status/narration/heartbeat post with
		// `metadata.transient: true` so the planner cannot resurface its own
		// 🚀/💬/⏳/✅ chatter as facts on later turns. The flag can sit on
		// `content.metadata` (Content.metadata path) OR on the top-level
		// `Memory.metadata` (when a connector forwards it through). Both
		// shapes MUST be filtered out.
		const memories = [
			makeMemory(
				"msg-1",
				USER_ID,
				"spawn the codex sub-agent",
				"discord",
				1000,
			),
			makeMemory("msg-2", AGENT_ID, "🚀 [codex] running", "discord", 2000, {
				transient: true,
			}),
			// Top-level Memory.metadata.transient shape — connectors that
			// forward `content.metadata` into `extraMetadata` land here.
			{
				id: "msg-3",
				agentId: AGENT_ID,
				roomId: ROOM_ID,
				entityId: AGENT_ID,
				createdAt: 3000,
				content: { text: "💬 [codex] reading file", source: "discord" },
				metadata: { transient: true },
			} as Memory,
			makeMemory("msg-4", AGENT_ID, "all set — deployed", "discord", 4000),
		];

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			makeMemory("current", USER_ID, "next task", "discord", 5000),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("User: spawn the codex sub-agent");
		expect(result.text).toContain("Agent: all set");
		expect(result.text).not.toContain("🚀 [codex]");
		expect(result.text).not.toContain("💬 [codex]");
	});

	it("keeps history when the incoming message has no metadata and its sender entity is unresolvable", async () => {
		// Memory.metadata is optional. A message from an entity that is not a
		// current room participant AND whose entity row is unavailable used to
		// throw on `metaData.entityName`, and the catch collapsed the whole
		// provider to "No recent messages available" — dropping ALL history.
		const memories = [
			makeMemory("msg-1", USER_ID, "hello agent", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "hi there", "discord", 2000),
		];

		const strangerMessage = makeMemory(
			"current",
			"00000000-0000-0000-0000-000000000009",
			"what did we discuss?",
			"discord",
			3000,
		);
		expect(strangerMessage.metadata).toBeUndefined();

		const result = await recentMessagesProvider.get(
			makeRuntime(memories),
			strangerMessage,
			{ values: {}, data: {}, text: "" },
		);

		expect((result.data as { error?: string })?.error).toBeUndefined();
		expect(result.data?.recentMessages).toHaveLength(2);
		expect(result.text).toContain("User: hello agent");
		expect(result.text).toContain("Agent: hi there");
		expect(result.text).toContain("Unknown User: what did we discuss?");
		expect(result.text).not.toBe("No recent messages available");
	});

	it("sorts memories by timestamp before applying the conversation window", async () => {
		const memories = Array.from({ length: 12 }, (_, index) => {
			const n = 12 - index;
			return makeMemory(
				`msg-${n}`,
				USER_ID,
				`message ${n}`,
				"discord",
				n * 1000,
			);
		});

		const result = await recentMessagesProvider.get(
			makeRuntime(memories, { conversationLength: 3 }),
			makeMemory("current", USER_ID, "status", "discord", 13_000),
			{ values: {}, data: {}, text: "" },
		);

		const recentMessages = result.data?.recentMessages as Memory[];
		expect(recentMessages.map((memory) => memory.id)).toEqual([
			"msg-10",
			"msg-11",
			"msg-12",
		]);
		expect(result.text).toContain("User: message 12");
		expect(result.text).not.toContain("User: message 9");
	});

	it("deepens same-room history for recall-referential questions", async () => {
		const memories = [
			makeMemory("msg-1", USER_ID, "whats 23 times 19?", "discord", 1000),
			makeMemory("msg-2", AGENT_ID, "23 times 19 is 437.", "discord", 2000),
			makeMemory("msg-3", USER_ID, "capital of france?", "discord", 3000),
			makeMemory("msg-4", AGENT_ID, "Paris.", "discord", 4000),
			makeMemory(
				"msg-5",
				USER_ID,
				"write a haiku about speed",
				"discord",
				5000,
			),
			makeMemory(
				"msg-6",
				AGENT_ID,
				"Quick wind / bright road",
				"discord",
				6000,
			),
			makeMemory(
				"msg-7",
				USER_ID,
				"python one-liner for reverse string",
				"discord",
				7000,
			),
			makeMemory("msg-8", AGENT_ID, "s[::-1]", "discord", 8000),
			makeMemory("msg-9", USER_ID, "bitcoin price?", "discord", 9000),
			makeMemory(
				"msg-10",
				AGENT_ID,
				"I need live data for that.",
				"discord",
				10_000,
			),
		];
		const runtime = makeRuntime(memories, { conversationLength: 4 });

		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory(
				"current",
				USER_ID,
				"what did i ask you to compute in my last math question?",
				"discord",
				11_000,
			),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 50,
				roomId: ROOM_ID,
				tableName: "messages",
			}),
		);
		const recentMessages = result.data?.recentMessages as Memory[];
		expect(recentMessages.map((memory) => memory.id)).toContain("msg-1");
		expect(result.text).toContain("User: whats 23 times 19?");
		expect(result.text).toContain("User: bitcoin price?");
	});

	it("skips the cross-room interactions fetch on the first compose of a turn", async () => {
		const OTHER_ROOM_ID = "00000000-0000-0000-0000-00000000000a";
		const memories = [
			makeMemory("msg-1", USER_ID, "hello agent", "discord", 1000),
		];
		const runtime = makeRuntime(
			memories,
			{},
			{
				getRoomsForParticipants: vi.fn(async () => [OTHER_ROOM_ID]),
				getMemoriesByRoomIds: vi.fn(async () => [
					{
						id: "cross-1",
						agentId: AGENT_ID,
						roomId: OTHER_ROOM_ID,
						entityId: USER_ID,
						createdAt: 500,
						content: { text: "the blue key is under the mat" },
					} as Memory,
				]),
			},
		);

		// Stage-1 compose: no prior provider results in the turn's cached state.
		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory("current", USER_ID, "gm", "discord", 2000),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.getRoomsForParticipants).not.toHaveBeenCalled();
		expect(runtime.getMemoriesByRoomIds).not.toHaveBeenCalled();
		expect(result.values?.recentMessageInteractions).toBe("");
		expect(result.data?.recentInteractions).toEqual([]);
		// The in-room transcript is unaffected by the lean pass.
		expect(result.text).toContain("User: hello agent");
		expect(result.text).not.toContain("blue key");
	});

	it("fetches cross-room interactions on a turn recompose (cached state has this provider)", async () => {
		const OTHER_ROOM_ID = "00000000-0000-0000-0000-00000000000a";
		const memories = [
			makeMemory("msg-1", USER_ID, "hello agent", "discord", 1000),
		];
		const runtime = makeRuntime(
			memories,
			{},
			{
				getRoomsForParticipants: vi.fn(async () => [ROOM_ID, OTHER_ROOM_ID]),
				getMemoriesByRoomIds: vi.fn(async () => [
					{
						id: "cross-1",
						agentId: AGENT_ID,
						roomId: OTHER_ROOM_ID,
						entityId: USER_ID,
						createdAt: 500,
						content: { text: "the blue key is under the mat" },
					} as Memory,
				]),
			},
		);

		// Planner/action recompose: the turn's cached state already holds a
		// RECENT_MESSAGES result from the Stage-1 compose.
		const result = await recentMessagesProvider.get(
			runtime,
			makeMemory("current", USER_ID, "gm", "discord", 2000),
			{
				values: {},
				data: { providers: { RECENT_MESSAGES: { text: "stage-1 result" } } },
				text: "",
			},
		);

		expect(runtime.getRoomsForParticipants).toHaveBeenCalled();
		expect(runtime.getMemoriesByRoomIds).toHaveBeenCalledWith({
			tableName: "messages",
			roomIds: [OTHER_ROOM_ID],
			limit: 20,
		});
		expect(result.data?.recentInteractions).toHaveLength(1);
		expect(result.values?.recentMessageInteractions).toContain(
			"the blue key is under the mat",
		);
	});
});
