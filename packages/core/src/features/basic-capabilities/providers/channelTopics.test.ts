/**
 * Tests for the CHANNEL_TOPICS provider — asserts it renders the room's topic
 * LRU most-recent-first, no-ops when the room has no topics or the service is
 * unregistered, and reflects topics hydrated from persisted room metadata after
 * a restart. Deterministic: a real ChannelTopicsService over an in-memory mock
 * runtime, no live model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelTopicsService } from "../../../services/channel-topics";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type {
	IAgentRuntime,
	Memory,
	Room,
	State,
	UUID,
} from "../../../types/index";
import { channelTopicsProvider } from "./channelTopics";

const ROOM = "00000000-0000-0000-0000-0000000000aa" as UUID;

function makeRoom(): Room {
	return { id: ROOM, source: "test", type: "GROUP" as Room["type"] };
}

async function makeRuntimeWithService(): Promise<{
	runtime: IAgentRuntime;
	service: ChannelTopicsService;
}> {
	const rooms = new Map<UUID, Room>([[ROOM, makeRoom()]]);
	const serviceRuntime = createMockRuntime({
		getRoom: vi.fn(async (id: UUID) => rooms.get(id) ?? null),
		updateRoom: vi.fn(async (room: Room) => {
			rooms.set(room.id, room);
		}),
	});
	const service = await ChannelTopicsService.start(serviceRuntime);
	const runtime = createMockRuntime({
		getService: vi.fn((type: string) =>
			type === ChannelTopicsService.serviceType ? service : null,
		),
	});
	return { runtime, service };
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000ff" as UUID,
		entityId: "00000000-0000-0000-0000-0000000000ee" as UUID,
		roomId: ROOM,
		content: { text: "hi" },
	} as Memory;
}

const EMPTY_STATE = {} as State;

describe("CHANNEL_TOPICS provider", () => {
	let runtime: IAgentRuntime;
	let service: ChannelTopicsService;

	beforeEach(async () => {
		({ runtime, service } = await makeRuntimeWithService());
	});

	it("declares the Stage-1 routing scope", () => {
		expect(channelTopicsProvider.name).toBe("CHANNEL_TOPICS");
		expect(channelTopicsProvider.alwaysInResponseState).toBe(true);
		expect(channelTopicsProvider.contexts).toContain("general");
	});

	it("renders the current LRU, most-recent first", async () => {
		await service.recordTopics(ROOM, ["billing", "auth", "vacation"]);
		const result = await channelTopicsProvider.get(
			runtime,
			makeMessage(),
			EMPTY_STATE,
		);
		expect(result.text).toBe(
			"# Current topics in this channel: vacation, auth, billing",
		);
		expect(result.data?.topics).toEqual(["vacation", "auth", "billing"]);
		expect(result.values?.channelTopics).toBe("vacation, auth, billing");
	});

	it("no-ops (empty result) when the room has no topics", async () => {
		const result = await channelTopicsProvider.get(
			runtime,
			makeMessage(),
			EMPTY_STATE,
		);
		expect(result.text).toBe("");
		expect(result.values).toEqual({});
		expect(result.data).toEqual({});
	});

	it("no-ops when the service is not registered", async () => {
		const noService = createMockRuntime({
			getService: vi.fn(() => null),
		});
		const result = await channelTopicsProvider.get(
			noService,
			makeMessage(),
			EMPTY_STATE,
		);
		expect(result.text).toBe("");
	});

	it("reflects persisted topics via service hydration (post-restart)", async () => {
		// Fresh service over a runtime whose room already carries persisted topics.
		const rooms = new Map<UUID, Room>([
			[
				ROOM,
				{
					id: ROOM,
					source: "test",
					type: "GROUP" as Room["type"],
					metadata: { currentTopics: ["persisted"] },
				},
			],
		]);
		const svcRuntime = createMockRuntime({
			getRoom: vi.fn(async (id: UUID) => rooms.get(id) ?? null),
			updateRoom: vi.fn(),
		});
		const freshService = await ChannelTopicsService.start(svcRuntime);
		const providerRuntime = createMockRuntime({
			getService: vi.fn(() => freshService),
		});

		const result = await channelTopicsProvider.get(
			providerRuntime,
			makeMessage(),
			EMPTY_STATE,
		);
		expect(result.text).toBe("# Current topics in this channel: persisted");
	});
});
