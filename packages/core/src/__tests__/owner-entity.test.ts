/** resolveOwnerEntityId must reject a non-UUID (legacy connector) world owner
 * id, matching resolveCanonicalOwnerId, so it cannot fork the owner subject. */
import { expect, it } from "vitest";
import { resolveOwnerEntityId } from "../owner-entity";
import { deterministicOwnerEntityId } from "../roles";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const ROOM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const WORLD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

/** Minimal runtime with no configured owner and a single room/world whose
 * ownership.ownerId is whatever the test supplies. */
function makeRuntime(ownerId: string | undefined): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getSetting: () => undefined,
		getRoomsForParticipant: async () => [ROOM_ID],
		getRoom: async () => ({ id: ROOM_ID, worldId: WORLD_ID }),
		getWorld: async () => ({
			id: WORLD_ID,
			metadata: { ownership: { ownerId } },
		}),
	} as unknown as IAgentRuntime;
}

it("rejects a non-UUID connector ownerId and falls back to the deterministic owner id", async () => {
	// A legacy Discord-style snowflake persisted into ownership.ownerId.
	const runtime = makeRuntime("123456789012345678");

	const resolved = await resolveOwnerEntityId(runtime);

	// The bug returned the snowflake verbatim, forking the owner subject_id away
	// from every other resolver. The fix rejects it and falls through.
	expect(resolved).not.toBe("123456789012345678");
	expect(resolved).toBe(deterministicOwnerEntityId(AGENT_ID));
});

it("returns a valid UUID ownerId recorded on a world", async () => {
	const ownerUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
	const runtime = makeRuntime(ownerUuid);

	expect(await resolveOwnerEntityId(runtime)).toBe(ownerUuid);
});
