/**
 * composeState cache behavior while trajectory recording is active. Recording
 * is observational: providers see the same cached state and reuse decisions as
 * an ordinary turn. Real AgentRuntime plus the real RECENT_MESSAGES provider
 * over a minimal in-memory adapter; no model or database server.
 */
import { describe, expect, it, vi } from "vitest";
import { recentMessagesProvider } from "../features/basic-capabilities/providers/recentMessages";
import { AgentRuntime } from "../runtime";
import {
	ChannelType,
	type Character,
	type IDatabaseAdapter,
	type Memory,
	type Provider,
	type State,
	type UUID,
} from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const OTHER_ROOM_ID = "11111111-1111-1111-1111-222222222222" as UUID;
const USER_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeRecordedMessage(id: string, text = "gm"): Memory {
	return {
		id: id as UUID,
		entityId: USER_ID,
		roomId: ROOM_ID,
		content: { text, source: "discord" },
		metadata: { type: "message", trajectoryStepId: "traj-step-1" },
	};
}

describe("composeState under trajectory recording", () => {
	it("still hands providers the turn's cached state, so the planner recompose fetches cross-room interactions", async () => {
		const runtime = new AgentRuntime({
			character: { name: "Agent" } as Character,
		});
		const agentEntity = {
			id: runtime.agentId,
			agentId: runtime.agentId,
			names: ["Agent"],
			components: [],
		};
		const userEntity = {
			id: USER_ID,
			agentId: runtime.agentId,
			names: ["User"],
			components: [],
		};
		const getRoomsForParticipants = vi.fn(async () => [ROOM_ID, OTHER_ROOM_ID]);
		const getMemoriesByRoomIds = vi.fn(async () => [
			{
				id: "cross-1" as UUID,
				agentId: runtime.agentId,
				roomId: OTHER_ROOM_ID,
				entityId: USER_ID,
				createdAt: 500,
				content: { text: "the blue key is under the mat" },
			} as Memory,
		]);
		runtime.registerDatabaseAdapter({
			getRoomsByIds: async () => [
				{
					id: ROOM_ID,
					agentId: runtime.agentId,
					source: "discord",
					type: ChannelType.GROUP,
					metadata: {},
				},
			],
			getEntitiesForRooms: async () => [
				{ roomId: ROOM_ID, entities: [agentEntity, userEntity] },
			],
			getEntitiesByIds: async (ids: UUID[]) =>
				[agentEntity, userEntity].filter((e) => ids.includes(e.id)),
			getMemories: async () => [
				{
					id: "msg-1" as UUID,
					agentId: runtime.agentId,
					roomId: ROOM_ID,
					entityId: USER_ID,
					createdAt: 1000,
					content: { text: "hello agent", source: "discord" },
				} as Memory,
			],
			getRoomsForParticipants,
			getMemoriesByRoomIds,
		} as unknown as IDatabaseAdapter);
		runtime.registerProvider(recentMessagesProvider);

		const message = makeRecordedMessage("cccccccc-cccc-cccc-cccc-cccccccccccc");

		// Stage-1 compose: first pass of the turn, lean — no cross-room fetch.
		const stage1State = await runtime.composeState(
			message,
			["RECENT_MESSAGES"],
			true,
			false,
		);
		expect(getRoomsForParticipants).not.toHaveBeenCalled();
		expect(getMemoriesByRoomIds).not.toHaveBeenCalled();
		expect(stage1State.values?.recentMessageInteractions).toBe("");

		// Planner recompose: RECENT_MESSAGES is already in the turn's cached
		// state, so its recompose gate must see it — trajectory recording
		// included — and run the cross-room interactions fetch.
		const plannerState = await runtime.composeState(
			message,
			["RECENT_MESSAGES"],
			true,
			false,
			["RECENT_MESSAGES"],
		);
		expect(getMemoriesByRoomIds).toHaveBeenCalledWith({
			tableName: "messages",
			roomIds: [OTHER_ROOM_ID],
			limit: 20,
		});
		expect(plannerState.values?.recentMessageInteractions).toContain(
			"the blue key is under the mat",
		);
	});

	it("reuses cached providers outside the refresh list without changing behavior", async () => {
		const runtime = new AgentRuntime({
			character: { name: "Agent" } as Character,
		});
		let factsRuns = 0;
		const seenCachedProviders: string[][] = [];
		const facts: Provider = {
			name: "FACTS",
			get: async (_runtime, _message, state: State) => {
				factsRuns += 1;
				seenCachedProviders.push(
					Object.keys(
						(state?.data?.providers as Record<string, unknown>) ?? {},
					),
				);
				return { text: `FACTS#${factsRuns}`, values: {}, data: {} };
			},
		};
		const recent: Provider = {
			name: "RECENT_MESSAGES",
			get: async () => ({ text: "recent", values: {}, data: {} }),
		};
		runtime.registerProvider(facts);
		runtime.registerProvider(recent);

		const message = makeRecordedMessage("dddddddd-dddd-dddd-dddd-dddddddddddd");
		await runtime.composeState(
			message,
			["FACTS", "RECENT_MESSAGES"],
			true,
			false,
		);
		const plannerState = await runtime.composeState(
			message,
			["FACTS", "RECENT_MESSAGES"],
			true,
			false,
			["RECENT_MESSAGES"],
		);

		// Trajectory recording must not force FACTS to run again. The runtime
		// records the planner access as a cache hit instead.
		expect(factsRuns).toBe(1);
		expect(seenCachedProviders[0]).toEqual([]);
		expect(seenCachedProviders).toHaveLength(1);
		expect(plannerState.text).toContain("FACTS#1");
	});
});
