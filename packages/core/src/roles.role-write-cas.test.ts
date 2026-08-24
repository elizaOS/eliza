/**
 * Exercises the #23100 atomic role-write path end-to-end against the real
 * in-memory adapter: `setEntityRoleCas` resolving the world through the
 * runtime, enforcing the per-attempt `authorize` predicate, committing via
 * `compareAndSwapWorldMetadata`, and the typed conflict / unauthorized /
 * world-not-found / malformed-target / missing-capability outcomes.
 * Deterministic unit harness — real adapter, fake runtime object, no model
 * or network.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter.ts";
import {
	ROLE_WRITE_CAS_MAX_ATTEMPTS,
	type RolesWorldMetadata,
	setEntityRoleCas,
} from "./roles.ts";
import type { IAgentRuntime, Memory, UUID, World } from "./types";
import { ChannelType } from "./types/index.ts";
import { stringToUuid } from "./utils.ts";

const AGENT_ID = stringToUuid("roles-cas-test-agent") as UUID;
const WORLD_ID = stringToUuid("roles-cas-test-world") as UUID;
const ROOM_ID = stringToUuid("roles-cas-test-room") as UUID;
const OWNER_ID = stringToUuid("roles-cas-test-owner") as UUID;
const TARGET_ID = stringToUuid("roles-cas-test-target") as UUID;

function baseMetadata(): RolesWorldMetadata {
	return {
		ownership: { ownerId: OWNER_ID },
		roles: { [OWNER_ID]: "OWNER", [TARGET_ID]: "USER" },
	};
}

/** Read the world back through the adapter so assertions use stored truth. */
async function storedWorld(
	adapter: InMemoryDatabaseAdapter,
): Promise<World | undefined> {
	const rows = await adapter.getWorldsByIds([WORLD_ID]);
	return rows[0];
}

async function storedRoles(
	adapter: InMemoryDatabaseAdapter,
): Promise<Record<string, string>> {
	const world = await storedWorld(adapter);
	return ((world?.metadata as RolesWorldMetadata | undefined)?.roles ??
		{}) as Record<string, string>;
}

function buildRuntime(adapter: InMemoryDatabaseAdapter): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		adapter,
		getRoom: async (roomId: UUID) =>
			roomId === ROOM_ID
				? {
						id: ROOM_ID,
						agentId: AGENT_ID,
						worldId: WORLD_ID,
						source: "test",
						type: ChannelType.WORLD,
					}
				: null,
		getWorld: async (worldId: UUID) => {
			if (worldId !== WORLD_ID) return null;
			const rows = await adapter.getWorldsByIds([WORLD_ID]);
			return rows[0] ?? null;
		},
	} as unknown as IAgentRuntime;
}

function buildMessage(): Memory {
	return {
		id: stringToUuid("roles-cas-message"),
		entityId: OWNER_ID,
		roomId: ROOM_ID,
		agentId: AGENT_ID,
		content: { text: "promote target" },
	} as Memory;
}

async function setup() {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.init();
	await adapter.createWorlds([
		{
			id: WORLD_ID,
			agentId: AGENT_ID,
			name: "cas-test-world",
			metadata: baseMetadata() as unknown as World["metadata"],
		},
	]);
	await adapter.createRooms([
		{
			id: ROOM_ID,
			agentId: AGENT_ID,
			worldId: WORLD_ID,
			source: "test",
			type: ChannelType.WORLD,
		},
	]);
	const runtime = buildRuntime(adapter);
	const message = buildMessage();
	return { adapter, runtime, message };
}

describe("setEntityRoleCas against the real in-memory adapter", () => {
	it("commits a role change with a durable audit row and typed result", async () => {
		const { adapter, runtime, message } = await setup();
		const result = await setEntityRoleCas(
			runtime,
			message,
			TARGET_ID,
			"ADMIN",
			{
				authorize: () => true,
			},
		);
		expect(result.status).toBe("committed");
		if (result.status === "committed") {
			expect(result.roles[TARGET_ID]).toBe("ADMIN");
		}
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "ADMIN" });
		const logs = await adapter.getLogs({ type: "role_audit" });
		expect(logs).toHaveLength(1);
		const body = logs[0]?.body as {
			source: string;
			metadata?: Record<string, unknown>;
		};
		expect(body?.source).toBe("role-write-cas");
		expect(body?.metadata?.targetEntityId).toBe(TARGET_ID);
		expect(body?.metadata?.previousRole).toBe("USER");
		expect(body?.metadata?.newRole).toBe("ADMIN");
		expect(body?.metadata?.outcome).toBe("committed");
	});

	it("returns unauthorized when the per-attempt authorize predicate denies on fresh state", async () => {
		const { adapter, runtime, message } = await setup();
		const result = await setEntityRoleCas(
			runtime,
			message,
			TARGET_ID,
			"ADMIN",
			{
				authorize: () => false,
			},
		);
		expect(result.status).toBe("unauthorized");
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "USER" });
		expect(await adapter.getLogs({ type: "role_audit" })).toHaveLength(0);
	});

	it("recovers from a lost race by re-reading and re-authorizing on the next attempt", async () => {
		const { adapter, runtime, message } = await setup();
		// A concurrent writer mutates metadata after the caller's read but
		// before the CAS commit on the FIRST attempt only; the retry must
		// re-resolve fresh state and still commit.
		let authorizeCalls = 0;
		const result = await setEntityRoleCas(
			runtime,
			message,
			TARGET_ID,
			"ADMIN",
			{
				authorize: async (fresh) => {
					authorizeCalls += 1;
					if (authorizeCalls === 1 && fresh) {
						await adapter.updateWorlds([
							{
								id: WORLD_ID,
								agentId: AGENT_ID,
								metadata: {
									...baseMetadata(),
									roles: { [OWNER_ID]: "OWNER", [TARGET_ID]: "GUEST" },
								} as unknown as World["metadata"],
							},
						]);
					}
					return Boolean(fresh);
				},
			},
		);
		expect(result.status).toBe("committed");
		expect(authorizeCalls).toBe(2);
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "ADMIN" });
		// Only the committed attempt's audit row exists — the lost race left none.
		expect(await adapter.getLogs({ type: "role_audit" })).toHaveLength(1);
	});

	it("surfaces conflict exhaustion after bounded attempts without writing or auditing", async () => {
		const { adapter, runtime, message } = await setup();
		let casCalls = 0;
		const realCas = adapter.compareAndSwapWorldMetadata.bind(adapter);
		// A writer keeps racing ahead of every CAS commit so the caller's
		// snapshot is always stale: attempt → conflict → re-read → attempt.
		const result = await setEntityRoleCas(
			runtime,
			message,
			TARGET_ID,
			"ADMIN",
			{
				maxAttempts: ROLE_WRITE_CAS_MAX_ATTEMPTS,
				authorize: async () => {
					casCalls += 1;
					const world = (await adapter.getWorldsByIds([WORLD_ID]))[0];
					if (world) {
						await adapter.updateWorlds([
							{
								id: WORLD_ID,
								agentId: AGENT_ID,
								metadata: { ...world.metadata, raceCounter: casCalls },
							},
						]);
					}
					return true;
				},
			},
		);
		void realCas;
		expect(result.status).toBe("conflict");
		expect(casCalls).toBe(CEILING());
		expect(await storedRoles(adapter)).toMatchObject({ [TARGET_ID]: "USER" });
		expect(await adapter.getLogs({ type: "role_audit" })).toHaveLength(0);
	});

	it("fails closed with a typed error when the target id is not a UUID", async () => {
		const { runtime, message } = await setup();
		await expect(
			setEntityRoleCas(runtime, message, "not-a-uuid", "ADMIN", {
				authorize: () => true,
			}),
		).rejects.toMatchObject({ code: "INVALID_ROLE_TARGET_ENTITY_ID" });
	});

	it("fails closed when the adapter lacks the CAS capability", async () => {
		const { runtime, message } = await setup();
		const noCap = { ...runtime, adapter: {} } as unknown as IAgentRuntime;
		await expect(
			setEntityRoleCas(noCap, message, TARGET_ID, "ADMIN", {
				authorize: () => true,
			}),
		).rejects.toMatchObject({ code: "WORLD_METADATA_CAS_CAPABILITY_REQUIRED" });
	});

	it("reports world_not_found when the world vanished", async () => {
		const { adapter, runtime, message } = await setup();
		await adapter.deleteWorlds([WORLD_ID]);
		const result = await setEntityRoleCas(
			runtime,
			message,
			TARGET_ID,
			"ADMIN",
			{
				authorize: () => true,
			},
		);
		expect(result.status).toBe("world_not_found");
	});

	it("conflicts when a legacy writer mutates the live stored metadata during authorization", async () => {
		const { adapter, runtime, message } = await setup();
		// The memory store returns LIVE stored objects. A legacy whole-world
		// writer (plain updateWorlds holding the same reference) mutates the
		// world's metadata IN PLACE while our authorize predicate awaits:
		// the helper's frozen snapshot must diverge from the stored state and
		// the CAS must retry/conflict instead of comparing two aliases of
		// the same mutated object and committing over the concurrent write.
		let attempts = 0;
		let firstViewTargetRole: string | undefined;
		const result = await setEntityRoleCas(
			runtime,
			message,
			TARGET_ID,
			"ADMIN",
			{
				maxAttempts: 2,
				authorize: (fresh) => {
					attempts += 1;
					if (attempts === 1) {
						firstViewTargetRole = fresh?.metadata?.roles?.[String(TARGET_ID)];
						// Mutate the LIVE stored world object in place — exactly
						// what a legacy blind writer holding the getWorldsByIds
						// reference would do between our read and our write.
						const world = (
							adapter as unknown as {
								worlds: Map<
									string,
									{ metadata: { roles: Record<string, string> } }
								>;
							}
						).worlds.get(String(WORLD_ID));
						if (world) {
							world.metadata.roles[String(TARGET_ID)] = "GUEST";
						}
					}
					return true;
				},
			},
		);
		// The mutation happened on attempt 1's authorize; attempt 2 re-reads,
		// re-freezes, and can commit the intended grant on the mutated state
		// — the point is the helper never compared aliased objects: it
		// either conflicts or re-reads. Assert the final state carries OUR
		// write only if a commit actually happened, and that no silent
		// merge lost the concurrent GUEST write without a fresh attempt.
		expect(firstViewTargetRole).toBe("USER");
		expect(attempts).toBe(2);
		expect(["committed", "conflict"]).toContain(result.status);
		if (result.status === "committed") {
			const world = (
				adapter as unknown as {
					worlds: Map<string, { metadata: { roles: Record<string, string> } }>;
				}
			).worlds.get(String(WORLD_ID));
			// The committed replacement was built from the POST-mutation
			// snapshot (roles include whatever the legacy writer set).
			expect(world?.metadata.roles[String(TARGET_ID)]).toBe("ADMIN");
		}
	});
});

function CEILING() {
	return ROLE_WRITE_CAS_MAX_ATTEMPTS;
}
