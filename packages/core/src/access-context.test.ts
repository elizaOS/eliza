import { describe, expect, it } from "vitest";
import { buildAccessContext } from "./access-context";
import type { IAgentRuntime, Memory, UUID } from "./types";

/**
 * buildAccessContext resolves the requester's identity, world, and role from a
 * message by running the real checkSenderRole against the world's role config.
 * Outside a world (no resolvable worldId) role/owner are undefined — callers
 * must read that as "no elevated access", never "unrestricted".
 */

const AGENT = "00000000-0000-0000-0000-0000000000a9" as UUID;
const USER = "00000000-0000-0000-0000-0000000000u5" as UUID;
const WORLD = "00000000-0000-0000-0000-00000000w012" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000r001" as UUID;

function runtimeWithRoles(
	roles: Record<string, string>,
	roomWorldId: UUID | undefined,
): IAgentRuntime {
	return {
		agentId: AGENT,
		getRoom: async (roomId: UUID) => ({ id: roomId, worldId: roomWorldId }),
		getWorld: async (id: UUID) => ({
			id,
			agentId: AGENT,
			serverId: "server-1",
			metadata: { roles },
		}),
		getSetting: () => undefined,
		getCache: async () => undefined,
		getComponents: async () => [],
		getEntityById: async () => null,
	} as unknown as IAgentRuntime;
}

const message = (source?: string): Memory =>
	({
		entityId: USER,
		roomId: ROOM,
		content: source ? { text: "hi", source } : { text: "hi" },
	}) as Memory;

describe("buildAccessContext", () => {
	it("resolves an OWNER requester with world + source", async () => {
		const ctx = await buildAccessContext(
			runtimeWithRoles({ [USER]: "OWNER" }, WORLD),
			message("discord"),
		);

		expect(ctx.requesterEntityId).toBe(USER);
		expect(ctx.worldId).toBe(WORLD);
		expect(ctx.role).toBe("OWNER");
		expect(ctx.isOwner).toBe(true);
		expect(ctx.source).toBe("discord");
	});

	it("resolves a plain USER (not owner)", async () => {
		const ctx = await buildAccessContext(
			runtimeWithRoles({ [USER]: "USER" }, WORLD),
			message(),
		);

		expect(ctx.role).toBe("USER");
		expect(ctx.isOwner).toBe(false);
		expect(ctx.source).toBeUndefined();
	});

	it("leaves role/owner undefined outside a world", async () => {
		const ctx = await buildAccessContext(
			runtimeWithRoles({ [USER]: "OWNER" }, undefined),
			message("discord"),
		);

		expect(ctx.requesterEntityId).toBe(USER);
		expect(ctx.worldId).toBeUndefined();
		expect(ctx.role).toBeUndefined();
		expect(ctx.isOwner).toBeUndefined();
	});
});
