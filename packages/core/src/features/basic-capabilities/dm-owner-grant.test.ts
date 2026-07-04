/**
 * Drives the real ENTITY_JOINED handler from createBasicCapabilitiesPlugin plus
 * the real roles.ts hasRoleAccess resolution against the exact world metadata the
 * handler writes, so DM-world owner grants are checked end to end with nothing mocked.
 */
import { describe, expect, it } from "vitest";
import { hasRoleAccess } from "../../roles.ts";
import type { IAgentRuntime, Memory } from "../../types";
import { EventType } from "../../types/events.ts";
import { ChannelType } from "../../types/primitives.ts";
import { createBasicCapabilitiesPlugin } from "./index.ts";

/**
 * P0 permission-bypass guard for the DM-world setup in `syncSingleUser`: a DM
 * world must NOT hardcode `ownership.ownerId = <sender>` + `roles[<sender>] =
 * OWNER` for ANY DM world. With no canonical owner configured
 * (ELIZA_ADMIN_ENTITY_ID unset — the DEFAULT) that promotes EVERY DM sender to
 * OWNER, clearing every `minRole: OWNER` gate (including SECRETS). Ownership is
 * granted ONLY to a configured owner, via roles.ts's `recordOwnerGrant`.
 */

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const STRANGER_ID = "22222222-2222-2222-2222-222222222222";
const ROOM_ID = "33333333-3333-3333-3333-333333333333";
const SERVER_ID = "44444444-4444-4444-4444-444444444444";

type CapturedConnection = { metadata?: Record<string, unknown> };

/**
 * Drive the real ENTITY_JOINED handler for a DM from `entityId` and return the
 * world metadata the handler passes to `ensureConnection`, plus a runtime that
 * serves that metadata back through `getWorld`/`getRoom` so the downstream
 * roles.ts resolution can be exercised on exactly what the handler produced.
 */
async function syncDmAndBuildResolutionRuntime(
	entityId: string,
	settings: Record<string, string | undefined>,
): Promise<{
	metadata: Record<string, unknown> | undefined;
	runtime: IAgentRuntime;
}> {
	const captured: CapturedConnection[] = [];
	const logger = {
		debug() {},
		info() {},
		success() {},
		warn() {},
		error() {},
	};

	const syncRuntime = {
		agentId: AGENT_ID,
		character: { name: "TestAgent" },
		logger,
		getSetting: (key: string) => settings[key],
		getEntitiesByIds: async () => [null],
		getWorldsByIds: async () => [null],
		ensureConnection: async (params: CapturedConnection) => {
			captured.push(params);
		},
	} as unknown as IAgentRuntime;

	const plugin = createBasicCapabilitiesPlugin();
	const handler = plugin.events?.[EventType.ENTITY_JOINED]?.[0];
	if (!handler) throw new Error("ENTITY_JOINED handler not registered");

	await handler({
		runtime: syncRuntime,
		entityId,
		worldId: SERVER_ID,
		roomId: ROOM_ID,
		metadata: { type: ChannelType.DM },
		source: "client_chat",
	} as never);

	expect(captured).toHaveLength(1);
	const metadata = captured[0]?.metadata;

	// A runtime that resolves messages against exactly the captured world
	// metadata, so hasRoleAccess/roles.ts sees what the handler wrote.
	const resolutionRuntime = {
		agentId: AGENT_ID,
		logger,
		getSetting: (key: string) => settings[key],
		getRoom: async () => ({ id: ROOM_ID, worldId: SERVER_ID }),
		getWorld: async () => ({ id: SERVER_ID, metadata }),
		getEntityById: async () => null,
		getRelationships: async () => [],
	} as unknown as IAgentRuntime;

	return { metadata, runtime: resolutionRuntime };
}

function dmMessage(entityId: string): Memory {
	return {
		entityId,
		roomId: ROOM_ID,
		content: { text: "hi", source: "client_chat" },
	} as unknown as Memory;
}

describe("basic-capabilities DM world ownership (P0 permission bypass)", () => {
	it("does NOT grant OWNER to a stranger DMing the agent when no owner is configured", async () => {
		const { metadata, runtime } = await syncDmAndBuildResolutionRuntime(
			STRANGER_ID,
			{}, // DEFAULT config: ELIZA_ADMIN_ENTITY_ID unset
		);

		// No hardcoded owner grant on the world.
		const roles = (metadata?.roles ?? {}) as Record<string, string>;
		const ownership = metadata?.ownership as { ownerId?: string } | undefined;
		expect(roles[STRANGER_ID]).toBeUndefined();
		expect(ownership?.ownerId).toBeUndefined();

		// And the stranger cannot clear a minRole: OWNER gate (e.g. SECRETS).
		const msg = dmMessage(STRANGER_ID);
		expect(await hasRoleAccess(runtime, msg, "OWNER")).toBe(false);
		expect(await hasRoleAccess(runtime, msg, "ADMIN")).toBe(false);
		// Basic USER-tier access is still allowed.
		expect(await hasRoleAccess(runtime, msg, "GUEST")).toBe(true);
	});

	it("grants OWNER to a CONFIGURED owner DMing the agent", async () => {
		const { metadata, runtime } = await syncDmAndBuildResolutionRuntime(
			OWNER_ID,
			{ ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
		);

		// Explicit, auditable owner grant recorded via recordOwnerGrant.
		const roles = (metadata?.roles ?? {}) as Record<string, string>;
		const roleSources = (metadata?.roleSources ?? {}) as Record<string, string>;
		const ownership = metadata?.ownership as { ownerId?: string } | undefined;
		expect(roles[OWNER_ID]).toBe("OWNER");
		expect(roleSources[OWNER_ID]).toBe("owner");
		expect(ownership?.ownerId).toBe(OWNER_ID);

		// The configured owner clears the OWNER gate.
		expect(await hasRoleAccess(runtime, dmMessage(OWNER_ID), "OWNER")).toBe(
			true,
		);
	});

	it("does NOT grant OWNER to a stranger even when a DIFFERENT owner is configured", async () => {
		const { metadata, runtime } = await syncDmAndBuildResolutionRuntime(
			STRANGER_ID,
			{ ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
		);

		const roles = (metadata?.roles ?? {}) as Record<string, string>;
		expect(roles[STRANGER_ID]).toBeUndefined();
		expect(await hasRoleAccess(runtime, dmMessage(STRANGER_ID), "OWNER")).toBe(
			false,
		);
	});
});
