/**
 * Gateway-boundary tests for the installation lifecycle seams in
 * discord-events.ts: a fenced (stale) guildCreate must skip onboarding
 * (handleGuildCreate and WORLD_JOINED), while a lifecycle-service-absent
 * runtime grandfathers the guild open. Deterministic unit harness with a
 * mocked DiscordServiceInternals and a real InstallationLifecycleService.
 */

import { EventEmitter } from "node:events";
import {
	createUniqueUuid,
	InstallationLifecycleService,
	stringToUuid,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupDiscordEventListeners } from "../discord-events";

const BOT_ID = "123";
const agentId = stringToUuid("agent");

type GuildLike = {
	id: string;
	name: string;
	joinedAt: Date | null;
};

function makeGuild(id: string, joinedAtIso: string | null): GuildLike {
	return {
		id,
		name: `Guild ${id}`,
		joinedAt: joinedAtIso ? new Date(joinedAtIso) : null,
	};
}

function makeService(service: InstallationLifecycleService | undefined) {
	const client = new EventEmitter() as EventEmitter & {
		user?: { id: string };
	};
	client.user = { id: BOT_ID };
	const runtime = {
		agentId,
		emitEvent: vi.fn(),
		getService: vi.fn(() => service),
		getSetting: vi.fn(() => undefined),
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
	};
	return {
		accountId: "test",
		allowAllSlashCommands: new Set(),
		allowedChannelIds: undefined,
		buildMemoryFromMessage: vi.fn(),
		character: {},
		client,
		discordSettings: {
			shouldIgnoreBotMessages: true,
			shouldRespondOnlyToMentions: false,
		},
		getChannelType: vi.fn(),
		handleGuildCreate: vi.fn(),
		handleGuildMemberAdd: vi.fn(),
		handleInteractionCreate: vi.fn(),
		handleReactionAdd: vi.fn(),
		handleReactionRemove: vi.fn(),
		isChannelAllowed: vi.fn(() => true),
		messageManager: { handleMessage: vi.fn() },
		resolveDiscordEntityId: vi.fn(),
		runtime,
		slashCommands: [],
		timeouts: [],
		voiceManager: undefined,
	};
}

function guildPayload(guild: GuildLike) {
	// The listener only reads guild.id/name/joinedAt; give it the shape it
	// touches (avoid pulling full discord.js Guild into this harness).
	return guild as unknown as Parameters<
		Parameters<typeof EventEmitter.prototype.on>[1]
	>[0];
}

describe("guildCreate installation lifecycle boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("a fenced stale guildCreate skips onboarding entirely", async () => {
		const lifecycle = new InstallationLifecycleService();
		const svc = makeService(lifecycle);
		setupDiscordEventListeners(
			svc as unknown as Parameters<typeof setupDiscordEventListeners>[0],
		);
		const acct = stringToUuid("acct");
		// First join + removal establish the removal fence.
		const first = makeGuild("g1", "2026-08-25T10:00:00Z");
		svc.client.emit("guildCreate", guildPayload(first));
		await new Promise((r) => setImmediate(r));
		svc.client.emit("guildDelete", guildPayload(makeGuild("g1", null)));
		await new Promise((r) => setImmediate(r));
		expect(svc.handleGuildCreate).toHaveBeenCalledTimes(1);
		// Redelivered OLD guildCreate (old joinedAt) after the removal: the
		// lifecycle fences it and the gateway must skip onboarding.
		svc.handleGuildCreate.mockClear();
		svc.client.emit("guildCreate", guildPayload(first));
		await new Promise((r) => setImmediate(r));
		expect(svc.handleGuildCreate).not.toHaveBeenCalled();
		// The listener resolves the account id the same way the production
		// seam does (discordInstallationAccountId undefined in the harness).
		const resolvedAcct = createUniqueUuid(
			svc.runtime as never,
			"discord-default-account",
		);
		expect(
			lifecycle.get({
				agentId,
				connectorId: "discord",
				connectorAccountId: resolvedAcct,
				externalWorldId: "g1",
			})?.state,
		).toBe("removed");
	});

	it("a genuine re-invite with a fresh joinedAt runs onboarding", async () => {
		const lifecycle = new InstallationLifecycleService();
		const svc = makeService(lifecycle);
		setupDiscordEventListeners(
			svc as unknown as Parameters<typeof setupDiscordEventListeners>[0],
		);
		svc.client.emit(
			"guildCreate",
			guildPayload(makeGuild("g2", "2026-08-25T10:00:00Z")),
		);
		await new Promise((r) => setImmediate(r));
		svc.client.emit("guildDelete", guildPayload(makeGuild("g2", null)));
		await new Promise((r) => setImmediate(r));
		expect(svc.handleGuildCreate).toHaveBeenCalledTimes(1);
		// Genuine re-invite: provider join time strictly after the removal.
		svc.client.emit(
			"guildCreate",
			guildPayload(
				makeGuild("g2", new Date(Date.now() + 60_000).toISOString()),
			),
		);
		await new Promise((r) => setImmediate(r));
		expect(svc.handleGuildCreate).toHaveBeenCalledTimes(2);
	});

	it("a missing lifecycle service grandfathers the guild open (onboarding runs)", async () => {
		const svc = makeService(undefined);
		setupDiscordEventListeners(
			svc as unknown as Parameters<typeof setupDiscordEventListeners>[0],
		);
		svc.client.emit(
			"guildCreate",
			guildPayload(makeGuild("g3", "2026-08-25T10:00:00Z")),
		);
		await new Promise((r) => setImmediate(r));
		expect(svc.handleGuildCreate).toHaveBeenCalledTimes(1);
	});
});
