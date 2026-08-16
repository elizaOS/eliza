/**
 * Deterministically exercises action-event world resolution across explicit
 * message context, room ownership, and every diagnostic fallback without a
 * database or event bus.
 */

import { describe, expect, it, vi } from "vitest";
import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
	type Room,
	type UUID,
} from "../types";
import { resolveActionEventWorldId } from "./action-event-world";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const roomId = "00000000-0000-0000-0000-000000000002" as UUID;
const worldId = "00000000-0000-0000-0000-000000000003" as UUID;

function makeRuntime(getRoom: IAgentRuntime["getRoom"]) {
	return {
		agentId,
		getRoom,
		reportError: vi.fn(),
	};
}

function message(explicitWorldId?: UUID): Pick<Memory, "roomId" | "worldId"> {
	return {
		roomId,
		...(explicitWorldId ? { worldId: explicitWorldId } : {}),
	};
}

function room(resolvedWorldId?: UUID): Room {
	return {
		id: roomId,
		agentId,
		source: "test",
		type: ChannelType.DM,
		...(resolvedWorldId ? { worldId: resolvedWorldId } : {}),
	};
}

describe("resolveActionEventWorldId", () => {
	it("uses an explicit message world without reading the room", async () => {
		const runtime = makeRuntime(vi.fn(async () => null));

		await expect(
			resolveActionEventWorldId(runtime, message(worldId), "test.scope"),
		).resolves.toBe(worldId);
		expect(runtime.getRoom).not.toHaveBeenCalled();
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("uses the room's world when the message omits it", async () => {
		const runtime = makeRuntime(vi.fn(async () => room(worldId)));

		await expect(
			resolveActionEventWorldId(runtime, message(), "test.scope"),
		).resolves.toBe(worldId);
		expect(runtime.getRoom).toHaveBeenCalledWith(roomId);
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it.each([
		["missing room", null, "ACTION_EVENT_ROOM_NOT_FOUND"],
		["room without a world", room(), "ACTION_EVENT_ROOM_WORLD_MISSING"],
	] as const)(
		"reports a %s and falls back to the agent world",
		async (_label, room, code) => {
			const runtime = makeRuntime(vi.fn(async () => room));

			await expect(
				resolveActionEventWorldId(runtime, message(), "test.scope"),
			).resolves.toBe(agentId);
			expect(runtime.reportError).toHaveBeenCalledWith(
				"test.scope",
				expect.objectContaining({ code }),
			);
		},
	);

	it("reports a failed room lookup and falls back to the agent world", async () => {
		const cause = new Error("database unavailable");
		const runtime = makeRuntime(
			vi.fn(async () => {
				throw cause;
			}),
		);

		await expect(
			resolveActionEventWorldId(runtime, message(), "test.scope"),
		).resolves.toBe(agentId);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"test.scope",
			expect.objectContaining({
				code: "ACTION_EVENT_WORLD_LOOKUP_FAILED",
				cause,
			}),
		);
	});
});
