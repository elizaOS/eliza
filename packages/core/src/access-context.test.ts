/**
 * Unit tests for buildAccessContext against a deterministic fake runtime (no live
 * model or DB): it must resolve the requester's identity, world, and role by
 * running role resolution against the SAME world resolveWorldForMessage picks, so
 * worldId, role, and isOwner always agree on one world. Outside a world (no
 * resolvable worldId) role/owner are undefined — callers must read that as "no
 * elevated access", never "unrestricted".
 */
import { describe, expect, it } from "vitest";
import { buildAccessContext } from "./access-context";
import { createUniqueUuid } from "./entities";
import type { IAgentRuntime, Memory, UUID } from "./types";

const AGENT = "00000000-0000-0000-0000-0000000000a9" as UUID;
const USER = "00000000-0000-0000-0000-0000000000u5" as UUID;
const WORLD = "00000000-0000-0000-0000-00000000w012" as UUID;
const ROOM = "00000000-0000-0000-0000-00000000r001" as UUID;
const DISCORD_SERVER_ID = "discord-server-7788";

function runtimeWithRoles(
	roles: Record<string, string>,
	roomWorldId: UUID | undefined,
	// Since #14707, a stored OWNER grant resolves OWNER only when it was made
	// deliberately through the role-management gate (roleSources "manual");
	// sourceless/legacy grants fold to GUEST. Fixtures granting OWNER must
	// model the deliberate shape.
	roleSources?: Record<string, string>,
): IAgentRuntime {
	return {
		agentId: AGENT,
		getRoom: async (roomId: UUID) => ({ id: roomId, worldId: roomWorldId }),
		getWorld: async (id: UUID) => ({
			id,
			agentId: AGENT,
			serverId: "server-1",
			metadata: { roles, ...(roleSources ? { roleSources } : {}) },
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

const discordMessage = (): Memory =>
	({
		entityId: USER,
		roomId: ROOM,
		content: { text: "hi", source: "discord" },
		metadata: { discordServerId: DISCORD_SERVER_ID },
	}) as unknown as Memory;

describe("buildAccessContext", () => {
	it("resolves an OWNER requester with world + source", async () => {
		const ctx = await buildAccessContext(
			runtimeWithRoles({ [USER]: "OWNER" }, WORLD, { [USER]: "manual" }),
			message("discord"),
		);

		expect(ctx.requesterEntityId).toBe(USER);
		expect(ctx.worldId).toBe(WORLD);
		expect(ctx.role).toBe("OWNER");
		expect(ctx.isOwner).toBe(true);
		expect(ctx.source).toBe("discord");
	});

	it("folds a sourceless (legacy/connector-written) OWNER grant to GUEST (#14707)", async () => {
		const ctx = await buildAccessContext(
			runtimeWithRoles({ [USER]: "OWNER" }, WORLD),
			message("discord"),
		);

		expect(ctx.role).toBe("GUEST");
		expect(ctx.isOwner).toBe(false);
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

	it("scopes role to the metadata-resolved world when the room has no worldId", async () => {
		// The room carries no worldId, but the Discord server metadata resolves a
		// world (resolveWorldForMessage's fallback). Role resolves to OWNER there,
		// so worldId MUST be that same world — never undefined. This is the case a
		// separate room lookup got wrong: role OWNER with worldId undefined, an
		// elevated role with no tenant scope.
		const runtime = runtimeWithRoles({ [USER]: "OWNER" }, undefined, {
			[USER]: "manual",
		});
		const expectedWorldId = createUniqueUuid(runtime, DISCORD_SERVER_ID);

		const ctx = await buildAccessContext(runtime, discordMessage());

		expect(ctx.role).toBe("OWNER");
		expect(ctx.isOwner).toBe(true);
		expect(ctx.worldId).toBe(expectedWorldId);
		expect(ctx.worldId).toBeDefined();
		expect(ctx.source).toBe("discord");
	});
});
