import { describe, expect, it, vi } from "vitest";
import { EventType } from "../../types/events.ts";
import type { IAgentRuntime, UUID } from "../../types/index.ts";
import { ChannelType } from "../../types/primitives.ts";
import { createBasicCapabilitiesPlugin } from "./index.ts";

function makeRuntime(settings: Record<string, string> = {}) {
	const ensureConnection = vi.fn(async () => undefined);
	const runtime = {
		agentId: "00000000-0000-0000-0000-0000000000a1" as UUID,
		getSetting: vi.fn((key: string) => settings[key]),
		getEntitiesByIds: vi.fn(async (ids: UUID[]) =>
			ids.map((id) => ({
				id,
				metadata: {
					username: `user-${id}`,
				},
			})),
		),
		getWorldsByIds: vi.fn(async () => []),
		ensureConnection,
		character: {
			name: "Test Agent",
		},
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			success: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime & {
		ensureConnection: typeof ensureConnection;
	};
	return { runtime, ensureConnection };
}

async function runEntityJoined(runtime: IAgentRuntime, entityId: UUID) {
	const handlers =
		createBasicCapabilitiesPlugin().events?.[EventType.ENTITY_JOINED];
	const handler = handlers?.[0];
	expect(handler).toBeDefined();
	await handler?.({
		runtime,
		entityId,
		worldId: "00000000-0000-0000-0000-0000000000b1" as UUID,
		roomId: "dm-channel-1" as UUID,
		source: "test",
		metadata: {
			originalId: "dm-channel-1",
			username: "sender",
			type: ChannelType.DM,
		},
	});
}

describe("basic-capabilities DM owner grants", () => {
	it("does not auto-grant OWNER to a new DM sender without an explicit owner setting", async () => {
		const entityId = "00000000-0000-0000-0000-0000000000c1" as UUID;
		const { runtime, ensureConnection } = makeRuntime();

		await runEntityJoined(runtime, entityId);

		expect(ensureConnection).toHaveBeenCalledTimes(1);
		expect(ensureConnection.mock.calls[0]?.[0].metadata).toEqual({
			settings: {},
		});
	});

	it("records an auditable owner grant when the DM sender is the configured owner", async () => {
		const entityId = "00000000-0000-0000-0000-0000000000c1" as UUID;
		const { runtime, ensureConnection } = makeRuntime({
			ELIZA_ADMIN_ENTITY_ID: entityId,
		});

		await runEntityJoined(runtime, entityId);

		expect(ensureConnection).toHaveBeenCalledTimes(1);
		expect(ensureConnection.mock.calls[0]?.[0].metadata).toEqual({
			ownership: { ownerId: entityId },
			roles: { [entityId]: "OWNER" },
			roleSources: { [entityId]: "owner" },
			settings: {},
		});
	});
});
