/**
 * Exercises the trust update_role handler's #23100 CAS integration against
 * the real core in-memory adapter: writes land on the handler's resolved
 * (configured WORLD_ID) world, no trailing whole-world `updateWorld`
 * clobbers concurrent metadata writers, per-attempt reauthorization turns a
 * mid-flight requester revocation into an explicit denial line (not a
 * phantom concurrency message), and exhaustion yields a typed retry line.
 * Deterministic unit harness — real adapter, stub runtime around it, no
 * model or network (the LLM extraction step is bypassed by supplying the
 * parsed assignments directly through `options.parameters`).
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../database/inMemoryAdapter.ts";
import type { IAgentRuntime, Memory, UUID, World } from "../../../types";
import { ChannelType } from "../../../types/index.ts";
import { stringToUuid } from "../../../utils.ts";
import { updateRoleHandler } from "./roles.ts";

const AGENT_ID = stringToUuid("trust-role-test-agent") as UUID;
const ROOM_ID = stringToUuid("trust-role-test-room") as UUID;
// A world DIFFERENT from the room's world — proving the handler writes the
// configured WORLD_ID world, not the message room's.
const CONFIG_WORLD_ID = stringToUuid("trust-role-test-config-world") as UUID;
const OWNER_ID = stringToUuid("trust-role-test-owner") as UUID;
const TARGET_ID = stringToUuid("trust-role-test-target") as UUID;

function baseRoles(): Record<string, string> {
	return {
		[OWNER_ID]: "OWNER",
		[TARGET_ID]: "USER",
	};
}

async function buildAdapter(): Promise<InMemoryDatabaseAdapter> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.init();
	await adapter.createWorlds([
		{
			id: CONFIG_WORLD_ID,
			agentId: AGENT_ID,
			name: "trust-config-world",
			metadata: {
				ownership: { ownerId: OWNER_ID },
				roles: baseRoles(),
			} as unknown as World["metadata"],
		},
	]);
	await adapter.createRooms([
		{
			id: ROOM_ID,
			agentId: AGENT_ID,
			// Deliberately NO worldId: the room does not resolve to the
			// configured world, so a room-world write would target nothing.
			source: "test",
			type: ChannelType.GROUP,
		},
	]);
	return adapter;
}

function buildRuntime(
	adapter: InMemoryDatabaseAdapter,
	over: Partial<IAgentRuntime> = {},
): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		adapter,
		getSetting: (key: string) =>
			key === "WORLD_ID" ? String(CONFIG_WORLD_ID) : null,
		getWorld: async (worldId: UUID) => {
			const rows = await adapter.getWorldsByIds([worldId]);
			return rows[0] ?? null;
		},
		getEntitiesForRoom: async () => [
			{
				id: OWNER_ID,
				agentId: AGENT_ID,
				names: ["Owner Entity"],
			},
			{
				id: TARGET_ID,
				agentId: AGENT_ID,
				names: ["Target Entity"],
			},
		],
		updateWorld: async (_world: World) => {
			// The handler must NEVER call this after the CAS loop — record
			// any invocation so the test can fail on it.
			updateWorldCalls.push(_world);
		},
		// The LLM extraction step always runs; explicit assignments supplied
		// through `options.parameters` take precedence over its output, so a
		// deterministic empty extraction keeps the harness model-free.
		dynamicPromptExecFromState: async () => ({ roleAssignments: [] }),
		...over,
	} as unknown as IAgentRuntime;
}

const updateWorldCalls: World[] = [];

function buildMessage(): Memory {
	return {
		id: stringToUuid("trust-role-message"),
		entityId: OWNER_ID,
		roomId: ROOM_ID,
		agentId: AGENT_ID,
		content: {
			text: "promote target to admin",
			channelType: ChannelType.GROUP,
			serverId: "trust-role-test-server",
		},
	} as Memory;
}

async function storedRoles(adapter: InMemoryDatabaseAdapter) {
	const rows = await adapter.getWorldsByIds([CONFIG_WORLD_ID]);
	return (rows[0]?.metadata as { roles?: Record<string, string> })?.roles ?? {};
}

async function runHandler(
	runtime: IAgentRuntime,
	message: Memory,
	assignments: Array<{ entityId: string; newRole: string }>,
) {
	return updateRoleHandler(runtime, message, {} as never, {
		parameters: { roleAssignments: assignments },
	});
}

describe("updateRoleHandler CAS integration (#23100)", () => {
	it("commits on the configured WORLD_ID world, not the message room's world", async () => {
		const adapter = await buildAdapter();
		const runtime = buildRuntime(adapter);
		const result = await runHandler(runtime, buildMessage(), [
			{ entityId: String(TARGET_ID), newRole: "ADMIN" },
		]);
		expect(result.success).toBe(true);
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "ADMIN" });
		// The durable audit row rides the CAS commit.
		const logs = await adapter.getLogs({ type: "role_audit" });
		expect(logs).toHaveLength(1);
	});

	it("does not issue a trailing whole-world updateWorld after the CAS loop", async () => {
		updateWorldCalls.length = 0;
		const adapter = await buildAdapter();
		const runtime = buildRuntime(adapter);
		await runHandler(runtime, buildMessage(), [
			{ entityId: String(TARGET_ID), newRole: "ADMIN" },
		]);
		// The pre-loop world object is stale after the CAS commits; writing
		// it back would resurrect the pre-CAS roles and drop the audit
		// evidence of the concurrent state. The handler must not do it.
		expect(updateWorldCalls).toHaveLength(0);
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "ADMIN" });
	});

	it("reports permission revoked — not a concurrent change — when fresh-state authorization denies", async () => {
		const adapter = await buildAdapter();
		const runtime = buildRuntime(adapter);
		const message = buildMessage();
		// Revoke the requester AFTER initial authorization but BEFORE the
		// CAS attempt: the per-attempt authorize predicate must surface
		// `unauthorized`, and the denial must name the permission loss.
		const realGetWorld = runtime.getWorld.bind(runtime);
		let firstCall = true;
		runtime.getWorld = async (worldId: UUID) => {
			const world = await realGetWorld(worldId);
			if (world && firstCall) {
				firstCall = false;
				// Handler's initial resolution still sees the requester as
				// OWNER (initial gate passes), but subsequent per-attempt
				// resolutions see them demoted.
				return world;
			}
			if (world) {
				const mutated = structuredClone(world);
				(mutated.metadata as { roles: Record<string, string> }).roles[
					String(OWNER_ID)
				] = "USER";
				return mutated;
			}
			return null;
		};
		const result = await runHandler(runtime, message, [
			{ entityId: String(TARGET_ID), newRole: "ADMIN" },
		]);
		expect(result.success).toBe(false);
		const text = (result as { text?: string }).text ?? "";
		expect(text).toContain("permission was revoked");
		expect(text).not.toContain("concurrent change");
		// No write, no audit row.
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "USER" });
		expect(await adapter.getLogs({ type: "role_audit" })).toHaveLength(0);
	});

	it("returns a typed retry line and no audit row when every CAS attempt conflicts", async () => {
		const adapter = await buildAdapter();
		const runtime = buildRuntime(adapter);
		// A writer keeps racing ahead of every CAS commit so the snapshot is
		// always stale: resolve → authorize → [RACE] → compare fails → retry.
		const realCas = adapter.compareAndSwapWorldMetadata.bind(adapter);
		let races = 0;
		adapter.compareAndSwapWorldMetadata = async (params) => {
			const world = (await adapter.getWorldsByIds([CONFIG_WORLD_ID]))[0];
			if (world) {
				races += 1;
				await adapter.updateWorlds([
					{
						...world,
						metadata: {
							...(world.metadata as object),
							raceCounter: races,
						},
					},
				]);
			}
			return realCas(params);
		};
		const result = await runHandler(runtime, buildMessage(), [
			{ entityId: String(TARGET_ID), newRole: "ADMIN" },
		]);
		expect(result.success).toBe(false);
		const text = (result as { text?: string }).text ?? "";
		expect(text).toContain("concurrent change");
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "USER" });
		expect(await adapter.getLogs({ type: "role_audit" })).toHaveLength(0);
	});

	it("keeps GUEST as the stored representation for a NONE assignment", async () => {
		const adapter = await buildAdapter();
		const runtime = buildRuntime(adapter);
		const result = await runHandler(runtime, buildMessage(), [
			{ entityId: String(TARGET_ID), newRole: "NONE" },
		]);
		expect(result.success).toBe(true);
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "GUEST" });
	});
});
