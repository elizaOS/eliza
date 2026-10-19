/**
 * A reaction records the reacting user's own name on their entity, never the
 * reacted-to message author's. Real `handleReaction`; the runtime and the
 * Discord objects are stand-ins for the platform boundary.
 */
import type { MessageReaction, User } from "discord.js";
import { expect, it, vi } from "vitest";
import {
	handleReaction,
	type ReactionServiceInternals,
} from "../discord-reactions";

function harness() {
	const ensureConnection = vi.fn(
		async (_params: Record<string, unknown>) => {},
	);
	const emitEvent = vi.fn();
	const service = {
		runtime: {
			agentId: "00000000-0000-4000-8000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			ensureConnection,
			emitEvent,
		},
		accountId: "default",
		resolveDiscordEntityId: (id: string) => `entity-${id}`,
		getChannelType: async () => "GROUP",
	} as unknown as ReactionServiceInternals;
	return { service, ensureConnection, emitEvent };
}

const author = {
	id: "111",
	username: "alice",
	globalName: "Alice Smith",
	displayName: "Alice Smith",
};

it("keeps the reactor's name when the reactor has no display name", async () => {
	const { service, ensureConnection, emitEvent } = harness();
	const reactor = {
		id: "222",
		username: "bob_real",
		globalName: null,
		partial: false,
	};
	const reaction = {
		partial: false,
		emoji: { name: "👍", id: null },
		message: {
			id: "m1",
			content: "lunch at noon?",
			author,
			channel: { id: "c1", name: "general" },
			guild: {
				id: "g1",
				name: "Guild",
				ownerId: "9",
				members: { cache: new Map() },
			},
		},
	};

	await handleReaction(
		service,
		reaction as unknown as MessageReaction,
		reactor as unknown as User,
		"add",
	);

	expect(ensureConnection.mock.calls[0]?.[0]).toMatchObject({
		entityId: "entity-222",
		userName: "bob_real",
		name: "bob_real",
	});
	expect(emitEvent.mock.calls[0]?.[1].message.metadata).toMatchObject({
		entityName: "bob_real",
		entityUserName: "bob_real",
	});
});

it("fetches a partial reactor instead of using the message author's username", async () => {
	const { service, ensureConnection } = harness();
	const bot = {
		id: "999",
		username: "eliza-bot",
		globalName: null,
		displayName: "eliza-bot",
	};
	const reactor = {
		id: "333",
		username: null,
		globalName: null,
		partial: true,
		fetch: vi.fn(async () => ({
			id: "333",
			username: "carol",
			globalName: "Carol",
			partial: false,
		})),
	};
	const reaction = {
		partial: false,
		emoji: { name: "❤️", id: null },
		message: {
			id: "m2",
			content: "hi",
			author: bot,
			channel: { id: "dm1" },
			guild: null,
		},
	};

	await handleReaction(
		service,
		reaction as unknown as MessageReaction,
		reactor as unknown as User,
		"add",
	);

	expect(reactor.fetch).toHaveBeenCalledTimes(1);
	expect(ensureConnection.mock.calls[0]?.[0]).toMatchObject({
		entityId: "entity-333",
		userName: "carol",
		name: "Carol",
	});
});
