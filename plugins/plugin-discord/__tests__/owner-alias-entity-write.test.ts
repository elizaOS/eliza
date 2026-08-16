/**
 * Drives an owner-aliased Discord author through the REAL history-backfill
 * entity construction (`ensureConnectionsForMessages`) with the real alias
 * predicate wired the way `DiscordService` wires it, and inspects the entity
 * records handed to `runtime.ensureConnections` — proving the canonical owner
 * entity is created bare (no wire identity) while a normal author's entity
 * carries full Discord identity. Deterministic: stubbed discord.js message
 * shapes and a capturing runtime; no gateway or DB.
 */
import { createUniqueUuid, type Entity } from "@elizaos/core";
import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
	ensureConnectionsForMessages,
	type HistoryServiceInternals,
} from "../discord-history";
import {
	isAliasedDiscordEntityId,
	resolveDiscordRuntimeEntityId,
} from "../identity";

const CANONICAL_OWNER = "11111111-1111-1111-1111-111111111111";
const WEBHOOK_ID = "990000000000000001";
const MEMBER_ID = "990000000000000002";

function makeRuntime() {
	const ensureConnections = vi.fn().mockResolvedValue(undefined);
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000002",
		character: { name: "Agent" },
		getSetting: (key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? CANONICAL_OWNER : undefined,
		ensureConnections,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	};
	return { runtime, ensureConnections };
}

function makeService(
	runtime: ReturnType<typeof makeRuntime>["runtime"],
	ownerIds: string[],
): HistoryServiceInternals {
	// The same wiring DiscordService.resolveDiscordEntityId /
	// isOwnerAliasedDiscordUser use — the REAL predicate, not a stub.
	const resolve = (userId: string) =>
		resolveDiscordRuntimeEntityId(
			runtime as never,
			userId,
			ownerIds,
		) as ReturnType<HistoryServiceInternals["resolveDiscordEntityId"]>;
	return {
		accountId: "discord-account-1",
		client: {} as HistoryServiceInternals["client"],
		runtime: runtime as unknown as HistoryServiceInternals["runtime"],
		messageManager: undefined,
		resolveDiscordEntityId: resolve,
		isOwnerAliasedDiscordUser: (userId: string) =>
			isAliasedDiscordEntityId(runtime as never, userId, resolve(userId)),
		getChannelType: vi.fn().mockResolvedValue("GROUP"),
		isGuildTextBasedChannel: vi.fn() as never,
	};
}

function makeMessage(authorId: string, username: string): Message {
	return {
		author: {
			id: authorId,
			username,
			globalName: `${username}-global`,
			displayAvatarURL: () => `https://cdn.example/${username}.png`,
		},
		member: { displayName: `${username}-nick` },
		channel: { id: "880000000000000001" },
		guild: {
			id: "870000000000000001",
			name: "Test Guild",
			ownerId: "860000000000000001",
		},
	} as unknown as Message;
}

describe("owner-aliased backfill entity writes", () => {
	it("creates the canonical owner entity bare while a normal author keeps full identity", async () => {
		const { runtime, ensureConnections } = makeRuntime();
		const service = makeService(runtime, [WEBHOOK_ID]);

		await ensureConnectionsForMessages(service, [
			makeMessage(WEBHOOK_ID, "sneaky-webhook"),
			makeMessage(MEMBER_ID, "alice"),
		]);

		expect(ensureConnections).toHaveBeenCalledTimes(1);
		const entities = ensureConnections.mock.calls[0][0] as Entity[];
		const canonical = entities.find((e) => e.id === CANONICAL_OWNER);
		const member = entities.find(
			(e) => e.id === createUniqueUuid(runtime as never, MEMBER_ID),
		);

		// The aliased author still yields an entity record (message rows must
		// link) but contributes ZERO wire identity to the canonical entity.
		expect(canonical).toBeDefined();
		expect(canonical?.names).toEqual([]);
		expect(canonical?.metadata).toEqual({});
		expect(JSON.stringify(canonical)).not.toContain("sneaky-webhook");

		// A normal author's entity carries the full Discord identity.
		expect(member?.names).toContain("alice");
		expect(member?.metadata?.discord).toMatchObject({
			id: MEMBER_ID,
			userName: "alice",
		});
	});

	it("suppresses the genuine owner's wire identity too when the canonical entity is a configured UUID (policy)", async () => {
		const { runtime, ensureConnections } = makeRuntime();
		// The genuine application owner is in the alias list, and the canonical
		// entity is a configured UUID (not their derived id): configuration owns
		// the canonical identity, so even the genuine owner's wire identity is
		// suppressed — there is no principled winner among collapsing wire
		// identities, and last-writer-wins is the corruption being prevented.
		const service = makeService(runtime, [MEMBER_ID]);

		await ensureConnectionsForMessages(service, [
			makeMessage(MEMBER_ID, "genuine-owner"),
		]);

		const entities = ensureConnections.mock.calls[0][0] as Entity[];
		expect(entities).toHaveLength(1);
		expect(entities[0]?.id).toBe(CANONICAL_OWNER);
		expect(entities[0]?.names).toEqual([]);
		expect(entities[0]?.metadata).toEqual({});
	});

	it("keeps full identity for an owner whose canonical entity IS their derived id", async () => {
		const { ensureConnections } = makeRuntime();
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000002",
			character: { name: "Agent" },
			getSetting: () => undefined,
			ensureConnections,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		};
		const derived = createUniqueUuid(runtime as never, MEMBER_ID);
		const selfCanonicalRuntime = {
			...runtime,
			getSetting: (key: string) =>
				key === "ELIZA_ADMIN_ENTITY_ID" ? derived : undefined,
		};
		const service = makeService(selfCanonicalRuntime as never, [MEMBER_ID]);

		await ensureConnectionsForMessages(service, [
			makeMessage(MEMBER_ID, "self-owner"),
		]);

		const entities = ensureConnections.mock.calls[0][0] as Entity[];
		expect(entities[0]?.id).toBe(derived);
		expect(entities[0]?.names).toContain("self-owner");
		expect(entities[0]?.metadata?.discord).toMatchObject({ id: MEMBER_ID });
	});
});
