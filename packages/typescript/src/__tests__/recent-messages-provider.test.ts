import { afterEach, describe, expect, it, vi } from "vitest";
import { recentMessagesProvider } from "../basic-capabilities/providers/recentMessages.ts";
import logger from "../logger";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Room,
	State,
} from "../types/index.ts";
import { ChannelType } from "../types/index.ts";
import { stringToUuid } from "../utils.ts";

const agentId = stringToUuid("agent");
const roomId = stringToUuid("room");
const senderId = stringToUuid("chen");

function createMessage(text: string, createdAt: number): Memory {
	return {
		id: stringToUuid(`${text}-${createdAt}`),
		entityId: senderId,
		agentId,
		roomId,
		content: {
			text,
			source: "discord",
		},
		createdAt,
		metadata: {
			entityName: "Chen",
		},
	} as Memory;
}

function createRuntime(
	overrides?: Partial<Record<string, unknown>>,
): IAgentRuntime {
	return {
		agentId,
		character: { name: "Milady" },
		getConversationLength: vi.fn().mockReturnValue(20),
		getRoom: vi.fn().mockResolvedValue({
			id: roomId,
			name: "Test Room",
			type: ChannelType.GROUP,
			metadata: {},
		} as Room),
		getMemories: vi.fn().mockResolvedValue([createMessage("earlier ping", 1)]),
		getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
		getRoomsForParticipants: vi.fn().mockResolvedValue([]),
		getEntitiesForRoom: vi.fn().mockResolvedValue([]),
		getEntityById: vi.fn().mockResolvedValue(null),
		getSetting: vi.fn().mockReturnValue(null),
		...overrides,
	} as unknown as IAgentRuntime;
}

function hasMissingEntityWarning(
	warnSpy: ReturnType<typeof vi.spyOn<typeof logger, "warn">>,
): boolean {
	return warnSpy.mock.calls.some(
		([, message]) => message === "No entity found for message",
	);
}

describe("recentMessagesProvider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("backfills historical senders that are no longer room participants", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const runtime = createRuntime({
			getEntityById: vi.fn().mockResolvedValue({
				id: senderId,
				names: ["Chen"],
				metadata: {
					discord: {
						name: "Chen",
					},
				},
			} as Entity),
		});

		const result = await recentMessagesProvider.get(
			runtime,
			createMessage("latest ping", 2),
			{} as State,
		);

		expect(runtime.getEntityById).toHaveBeenCalledWith(senderId);
		expect(result.text).toContain("Chen: earlier ping");
		expect(hasMissingEntityWarning(warnSpy)).toBe(false);
	});

	it("falls back to message metadata when the sender entity record is unavailable", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const runtime = createRuntime();

		const result = await recentMessagesProvider.get(
			runtime,
			createMessage("latest ping", 2),
			{} as State,
		);

		expect(runtime.getEntityById).toHaveBeenCalledWith(senderId);
		expect(result.text).toContain("Chen: earlier ping");
		expect(hasMissingEntityWarning(warnSpy)).toBe(false);
	});
});
