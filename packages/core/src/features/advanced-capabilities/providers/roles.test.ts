/**
 * Unit tests for the advanced ROLES provider using a deterministic runtime
 * boundary while exercising the real room gating, world ownership lookup,
 * entity identity resolution, username dedupe, role bucketing, and Markdown
 * rendering implementation.
 */
import { describe, expect, it, vi } from "vitest";
import {
	ChannelType,
	type Entity,
	type IAgentRuntime,
	type Memory,
	Role,
	type Room,
	type State,
	type UUID,
	type World,
} from "../../../types/index.ts";
import { roleProvider } from "./roles.ts";

const agentId = "30000000-0000-0000-0000-000000000001" as UUID;
const roomId = "30000000-0000-0000-0000-000000000010" as UUID;
const worldId = "30000000-0000-0000-0000-000000000020" as UUID;
const bobId = "30000000-0000-0000-0000-000000000031" as UUID;
const carolId = "30000000-0000-0000-0000-000000000032" as UUID;
const daveId = "30000000-0000-0000-0000-000000000033" as UUID;
const eveId = "30000000-0000-0000-0000-000000000034" as UUID;
const frankId = "30000000-0000-0000-0000-000000000035" as UUID;
const aliceId = "30000000-0000-0000-0000-000000000036" as UUID;
const ghostId = "30000000-0000-0000-0000-000000000037" as UUID;
const missingId = "30000000-0000-0000-0000-000000000039" as UUID;

const message: Memory = {
	id: "30000000-0000-0000-0000-000000000041" as UUID,
	agentId,
	entityId: bobId,
	roomId,
	content: { text: "Who are the admins here?" },
};

const state: State = { values: {}, data: {}, text: "" };

const DM_NOTICE =
	"No access to role information in DMs, the role provider is only available in group scenarios.";
const NO_ROLE_INFO = "No role information available for this server.";

function groupRoom(overrides?: Partial<Room>): Room {
	return {
		id: roomId,
		agentId,
		source: "test",
		type: ChannelType.GROUP,
		worldId,
		...overrides,
	};
}

function world(
	metadata?: World["metadata"],
	overrides?: Partial<World>,
): World {
	return { id: worldId, agentId, metadata, ...overrides };
}

function ownedWorld(roles?: Record<string, Role>): World {
	return world({
		ownership: { ownerId: bobId },
		...(roles ? { roles } : {}),
	});
}

function entity(
	id: UUID | undefined,
	names: string[],
	metadata?: Entity["metadata"],
): Entity {
	return { id, agentId, names, metadata };
}

function makeRuntime(args: {
	room?: Room | null;
	world?: World | null;
	entities?: Partial<Record<UUID, Entity>>;
}) {
	const getRoom = vi.fn(async () => args.room ?? null);
	const getWorld = vi.fn(async () => args.world ?? null);
	const getEntityById = vi.fn(async (id: UUID) => args.entities?.[id]);
	return {
		runtime: {
			agentId,
			getRoom,
			getWorld,
			getEntityById,
		} as unknown as IAgentRuntime,
		getRoom,
		getWorld,
		getEntityById,
	};
}

describe("roleProvider", () => {
	it("exposes the provider contract used by admin and settings contexts", () => {
		expect(roleProvider).toMatchObject({
			name: "ROLES",
			contexts: ["admin", "settings"],
			contextGate: { anyOf: ["admin", "settings"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		});
		expect(roleProvider.description).toEqual(expect.any(String));
	});

	it("throws when neither the state nor the runtime can resolve the room", async () => {
		const { runtime, getRoom } = makeRuntime({ room: null });

		await expect(roleProvider.get(runtime, message, state)).rejects.toThrow(
			"No room found",
		);
		expect(getRoom).toHaveBeenCalledWith(message.roomId);
	});

	it.each([[ChannelType.DM], [ChannelType.SELF]] as const)(
		"returns the DM notice instead of hierarchy data for a %s room",
		async (roomType) => {
			const { runtime, getWorld } = makeRuntime({
				room: groupRoom({ type: roomType }),
			});

			const result = await roleProvider.get(runtime, message, state);

			expect(result).toEqual({
				data: { roles: [] },
				values: { roles: DM_NOTICE },
				text: DM_NOTICE,
			});
			expect(getWorld).not.toHaveBeenCalled();
		},
	);

	it("throws when a group room has no world id", async () => {
		const { runtime, getWorld } = makeRuntime({
			room: groupRoom({ worldId: undefined }),
		});

		await expect(roleProvider.get(runtime, message, state)).rejects.toThrow(
			"No world ID found for room",
		);
		expect(getWorld).not.toHaveBeenCalled();
	});

	const ownerlessWorld = {
		id: worldId,
		agentId,
		metadata: { ownership: {} },
	} as unknown as World;

	it.each([
		["an absent world", null],
		["a world without an ownership block", world()],
		["a world whose ownership block lacks an owner id", ownerlessWorld],
	] as const)("returns the empty notice for %s", async (_label, w) => {
		const { runtime, getEntityById } = makeRuntime({
			room: groupRoom(),
			world: w,
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result).toEqual({
			data: { roles: [] },
			values: { roles: NO_ROLE_INFO },
			text: NO_ROLE_INFO,
		});
		expect(getEntityById).not.toHaveBeenCalled();
	});

	it("returns the empty notice when the world has no role assignments", async () => {
		const { runtime, getEntityById } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld(),
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result).toEqual({
			data: { roles: [] },
			values: { roles: NO_ROLE_INFO },
			text: NO_ROLE_INFO,
		});
		expect(getEntityById).not.toHaveBeenCalled();
	});

	it("renders the full grouped hierarchy and mirrors it across data, values, and text", async () => {
		const { runtime, getEntityById } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({
				[bobId]: Role.OWNER,
				[carolId]: Role.ADMIN,
				[daveId]: Role.MEMBER,
			}),
			entities: {
				[bobId]: entity(bobId, ["Bob B"], { username: "bobh" }),
				[carolId]: entity(carolId, ["Carol C"], { username: "carol_admin" }),
				[daveId]: entity(daveId, ["Dave D"], { username: "dave_m" }),
			},
		});

		const result = await roleProvider.get(runtime, message, state);

		const expected =
			"# Server Role Hierarchy\n\n## Owners\nBob B (Bob B)\n\n## Administrators\nCarol C (Carol C) (carol_admin)\n\n## Members\nDave D (Dave D) (dave_m)\n";
		expect(result.text).toBe(expected);
		expect(result.data.roles).toBe(result.text);
		expect(result.values.roles).toBe(result.text);
		for (const id of [bobId, carolId, daveId]) {
			expect(getEntityById).toHaveBeenCalledWith(id);
		}
	});

	it("renders the owner display name without the username suffix used for admins and members", async () => {
		const { runtime } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({ [bobId]: Role.OWNER }),
			entities: {
				[bobId]: entity(bobId, ["Bob B"], { username: "bobh" }),
			},
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result.text).toBe(
			"# Server Role Hierarchy\n\n## Owners\nBob B (Bob B)\n\n",
		);
		expect(result.text).not.toContain("(bobh)");
	});

	it("buckets unknown and unassigned roles into members", async () => {
		const { runtime } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({
				[eveId]: Role.NONE,
				[frankId]: Role.GUEST,
			}),
			entities: {
				[eveId]: entity(eveId, ["Eve E"], { username: "eve_none" }),
				[frankId]: entity(frankId, ["Frank F"], { username: "frank_guest" }),
			},
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result.text).toBe(
			"# Server Role Hierarchy\n\n## Members\nEve E (Eve E) (eve_none)\nFrank F (Frank F) (frank_guest)\n",
		);
		expect(result.text.indexOf("Eve E")).toBeLessThan(
			result.text.indexOf("Frank F"),
		);
	});

	it("skips role entries whose entity cannot be resolved and reports empty when none resolve", async () => {
		const { runtime } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({ [missingId]: Role.MEMBER }),
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result).toEqual({
			data: { roles: [] },
			values: { roles: NO_ROLE_INFO },
			text: NO_ROLE_INFO,
		});
	});

	it("skips entities with only metadata identity and no non-empty names", async () => {
		const { runtime } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({ [ghostId]: Role.MEMBER }),
			entities: {
				[ghostId]: entity(ghostId, [], { name: "Ghost", username: "ghost_u" }),
			},
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result.text).toBe(NO_ROLE_INFO);
	});

	it("dedupes by username keeping the first assignment even across buckets", async () => {
		const { runtime } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({
				[aliceId]: Role.OWNER,
				[bobId]: Role.ADMIN,
			}),
			entities: {
				[aliceId]: entity(aliceId, ["Alice A"], { username: "shared" }),
				[bobId]: entity(bobId, ["Bob B"], { username: "shared" }),
			},
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result.text).toBe(
			"# Server Role Hierarchy\n\n## Owners\nAlice A (Alice A)\n\n",
		);
		expect(result.text).not.toContain("## Administrators");
		expect(result.text).not.toContain("Bob B");
	});

	it("resolves usernames through the userName alias before falling back to the first name", async () => {
		const { runtime } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({
				[carolId]: Role.MEMBER,
				[daveId]: Role.MEMBER,
			}),
			entities: {
				[carolId]: entity(carolId, ["Carol C"], {
					name: "Carol",
					userName: "carol_user",
				}),
				[daveId]: entity(daveId, ["Dave D"]),
			},
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result.text).toContain("Carol (Carol C) (carol_user)");
		expect(result.text).toContain("Dave D (Dave D) (Dave D)");
	});

	it("completes identity from platform-specific metadata when the top level has gaps", async () => {
		const { runtime } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({ [carolId]: Role.MEMBER }),
			entities: {
				[carolId]: entity(carolId, ["Carol C"], {
					username: "u1",
					discord: { name: "Discord Carol" },
				}),
			},
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result.text).toContain("Discord Carol (Carol C) (u1)");
	});

	it("filters whitespace-only names and ignores whitespace-only metadata fields", async () => {
		const { runtime } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({ [bobId]: Role.MEMBER }),
			entities: {
				[bobId]: entity(bobId, ["   ", "Bob B"], {
					name: "   ",
					username: "bobw",
				}),
			},
		});

		const result = await roleProvider.get(runtime, message, state);

		expect(result.text).toBe(
			"# Server Role Hierarchy\n\n## Members\nBob B (Bob B) (bobw)\n",
		);
	});

	it("prefers the room already attached to the state over a runtime lookup", async () => {
		const { runtime, getRoom } = makeRuntime({
			room: groupRoom(),
			world: ownedWorld({ [daveId]: Role.MEMBER }),
			entities: {
				[daveId]: entity(daveId, ["Dave D"], { username: "dave_m" }),
			},
		});
		const stateWithRoom: State = {
			values: {},
			data: { room: groupRoom() },
			text: "",
		};

		const result = await roleProvider.get(runtime, message, stateWithRoom);

		expect(getRoom).not.toHaveBeenCalled();
		expect(result.text).toBe(
			"# Server Role Hierarchy\n\n## Members\nDave D (Dave D) (dave_m)\n",
		);
	});
});
