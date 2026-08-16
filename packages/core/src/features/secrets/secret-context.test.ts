/**
 * Pins world-scoped secret context to Memory.worldId, not Memory.roomId.
 */
import { describe, expect, it } from "vitest";
import { ChannelType } from "../../types/primitives";
import { getSecretHandler } from "./actions/get-secret";
import { secretContextFromMessage } from "./secret-context";

describe("secretContextFromMessage", () => {
	const runtime = { agentId: "agent-1" };
	const message = {
		entityId: "user-1",
		worldId: "world-aaa",
		roomId: "room-bbb",
	};

	it("uses message.worldId for world-level operations, never roomId", () => {
		expect(secretContextFromMessage(runtime, message, "world")).toEqual({
			level: "world",
			agentId: "agent-1",
			worldId: "world-aaa",
			userId: undefined,
			requesterId: "user-1",
		});
	});

	it("omits worldId for global and user levels", () => {
		expect(
			secretContextFromMessage(runtime, message, "global").worldId,
		).toBeUndefined();
		expect(secretContextFromMessage(runtime, message, "user")).toMatchObject({
			level: "user",
			userId: "user-1",
			worldId: undefined,
		});
	});

	it("does not invent a world id from the room when worldId is missing", () => {
		expect(
			secretContextFromMessage(
				runtime,
				{ entityId: "user-1", roomId: "room-bbb" },
				"world",
			).worldId,
		).toBeUndefined();
	});
});

describe("getSecretHandler world partition", () => {
	it("looks up world-level secrets with message.worldId, not roomId", async () => {
		const seen: Array<{ key: string; worldId?: string; level: string }> = [];
		const runtime = {
			agentId: "agent-1",
			getService: () => ({
				get: async (
					key: string,
					context: { worldId?: string; level: string },
				) => {
					seen.push({ key, worldId: context.worldId, level: context.level });
					return "sk-test";
				},
			}),
		};
		const message = {
			entityId: "user-1",
			roomId: "room-bbb",
			worldId: "world-aaa",
			content: { text: "", channelType: ChannelType.DM },
		};

		const result = await getSecretHandler(
			runtime as never,
			message as never,
			undefined,
			{
				parameters: { key: "OPENAI_API_KEY", level: "world", mask: false },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(seen).toEqual([
			{ key: "OPENAI_API_KEY", worldId: "world-aaa", level: "world" },
		]);
	});
});
