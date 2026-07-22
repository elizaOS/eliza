/**
 * Tests for the CHANNEL_TOPICS provider — asserts it renders the room's topic
 * LRU most-recent-first, no-ops when the room has no topics or the service is
 * unregistered, and reflects topics hydrated from persisted room metadata after
 * a restart. Deterministic: real AgentRuntime instances use the in-memory
 * database adapter; no model call is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCharacter } from "../../../character";
import { InMemoryDatabaseAdapter } from "../../../database/inMemoryAdapter";
import { AgentRuntime } from "../../../runtime";
import { ChannelTopicsService } from "../../../services/channel-topics";
import type { Memory, Room, State, UUID } from "../../../types/index";
import { channelTopicsProvider } from "./channelTopics";

const ROOM = "00000000-0000-0000-0000-0000000000aa" as UUID;

function makeRoom(): Room {
	return { id: ROOM, source: "test", type: "GROUP" as Room["type"] };
}

class FailingRoomReadAdapter extends InMemoryDatabaseAdapter {
	failReads = false;

	override async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
		if (this.failReads) throw new Error("room read unavailable");
		return super.getRoomsByIds(roomIds);
	}
}

const activeRuntimes: AgentRuntime[] = [];

async function makeRuntimeWithService(
	rooms?: Room[],
	adapter?: InMemoryDatabaseAdapter,
): Promise<{ runtime: AgentRuntime; service: ChannelTopicsService }> {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "ChannelTopicsProviderAgent" }),
		adapter: adapter ?? new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize();
	await runtime.createRooms(rooms ?? [makeRoom()]);
	await runtime.registerService(ChannelTopicsService);
	const service = runtime.getService<ChannelTopicsService>(
		ChannelTopicsService.serviceType,
	);
	if (!service) throw new Error("ChannelTopicsService did not register");
	activeRuntimes.push(runtime);
	return { runtime, service };
}

async function makeRuntimeWithoutService(): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "NoChannelTopicsProviderAgent" }),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize();
	activeRuntimes.push(runtime);
	return runtime;
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
	let runtime: AgentRuntime;
	let service: ChannelTopicsService;

	beforeEach(async () => {
		({ runtime, service } = await makeRuntimeWithService());
	});

	afterEach(async () => {
		await Promise.all(
			activeRuntimes.splice(0).map(async (activeRuntime) => {
				await activeRuntime.stop();
				await activeRuntime.close();
			}),
		);
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
		const noService = await makeRuntimeWithoutService();
		const result = await channelTopicsProvider.get(
			noService,
			makeMessage(),
			EMPTY_STATE,
		);
		expect(result.text).toBe("");
	});

	it("reflects persisted topics via service hydration (post-restart)", async () => {
		const { runtime: providerRuntime } = await makeRuntimeWithService([
			{
				id: ROOM,
				source: "test",
				type: "GROUP" as Room["type"],
				metadata: { currentTopics: ["persisted"] },
			},
		]);

		const result = await channelTopicsProvider.get(
			providerRuntime,
			makeMessage(),
			EMPTY_STATE,
		);
		expect(result.text).toBe("# Current topics in this channel: persisted");
	});

	it("renders unavailable when persisted topics cannot be loaded", async () => {
		const adapter = new FailingRoomReadAdapter();
		const { runtime: failingRuntime } = await makeRuntimeWithService(
			[makeRoom()],
			adapter,
		);
		adapter.failReads = true;

		const result = await channelTopicsProvider.get(
			failingRuntime,
			makeMessage(),
			EMPTY_STATE,
		);
		expect(result).toEqual({
			text: "# Current topics unavailable",
			values: { channelTopicsUnavailable: true },
			data: { unavailable: true },
		});
		expect(failingRuntime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({ code: "CHANNEL_TOPICS_HYDRATE_FAILED" }),
		);
	});
});
