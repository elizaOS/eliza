/**
 * Identity strengthening tests for RelationshipsService (Track B).
 *
 * Uses real PGLite-backed runtime + plugin-sql; no SQL mocks per
 * project convention.
 *
 * Covers:
 *   - upsertIdentity inserts and dedupes by (entity, platform, handle)
 *   - confidence stays at the max of all observations
 *   - evidence_message_ids accumulates without duplicates
 *   - getEntityIdentities round-trip
 *   - proposeMerge / acceptMerge folds identities + drops the secondary
 *   - rejectMerge marks the candidate without merging
 *   - auto-merge fires when confidence >= 0.85 and >= 2 evidence messages
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCharacter } from "../character.ts";
import { recentMessagesProvider } from "../features/basic-capabilities/providers/recentMessages.ts";
import { AgentRuntime } from "../runtime.ts";
import type { RelationshipsService } from "../services/relationships.ts";
import type { Memory, State } from "../types/index.ts";
import { asUUID } from "../types/primitives.ts";
import { stringToUuid } from "../utils.ts";

interface Fixture {
	runtime: AgentRuntime;
	service: RelationshipsService;
	cleanup: () => Promise<void>;
	makeEntity: (label: string) => Promise<ReturnType<typeof asUUID>>;
}

async function setup(): Promise<Fixture> {
	const pgliteDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "identity-test-pglite-"),
	);
	const prevPgliteDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = pgliteDir;

	const character = createCharacter({ name: "IdentityTestAgent" });
	const runtime = new AgentRuntime({
		character,
		plugins: [],
		logLevel: "warn",
		enableAutonomy: false,
	});

	const { default: pluginSql } = await import("@elizaos/plugin-sql");
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();

	const service = (await runtime.getServiceLoadPromise(
		"relationships",
	)) as RelationshipsService;

	const cleanup = async () => {
		try {
			await runtime.stop();
		} catch {}
		try {
			await runtime.close();
		} catch {}
		if (prevPgliteDir !== undefined) {
			process.env.PGLITE_DATA_DIR = prevPgliteDir;
		} else {
			delete process.env.PGLITE_DATA_DIR;
		}
		try {
			fs.rmSync(pgliteDir, { recursive: true, force: true });
		} catch {}
	};

	const makeEntity = async (label: string) => {
		const entityId = asUUID(
			stringToUuid(`identity-test-${label}-${Math.random()}`),
		);
		await runtime.createEntity({
			id: entityId,
			names: [label],
			agentId: runtime.agentId,
		});
		return entityId;
	};

	return { runtime, service, cleanup, makeEntity };
}

describe("RelationshipsService identity surface", () => {
	let fx: Fixture;

	beforeEach(async () => {
		fx = await setup();
	});

	afterEach(async () => {
		await fx.cleanup();
	});

	it("upsertIdentity inserts a new identity row", async () => {
		const entityId = await fx.makeEntity("Alice");
		const messageId = asUUID(stringToUuid("alice-msg-1"));
		await fx.service.upsertIdentity(
			entityId,
			{
				platform: "github",
				handle: "alice",
				confidence: 0.6,
				source: "relationship_extraction",
			},
			[messageId],
		);
		const identities = await fx.service.getEntityIdentities(entityId);
		expect(identities).toHaveLength(1);
		expect(identities[0].platform).toBe("github");
		expect(identities[0].handle).toBe("alice");
		expect(identities[0].confidence).toBeCloseTo(0.6, 5);
		expect(identities[0].evidenceMessageIds).toEqual([messageId]);
	});

	it("upsertIdentity strengthens confidence and dedupes evidence", async () => {
		const entityId = await fx.makeEntity("Bob");
		const m1 = asUUID(stringToUuid("bob-msg-1"));
		const m2 = asUUID(stringToUuid("bob-msg-2"));

		await fx.service.upsertIdentity(
			entityId,
			{ platform: "twitter", handle: "bob", confidence: 0.5 },
			[m1],
		);
		await fx.service.upsertIdentity(
			entityId,
			{ platform: "twitter", handle: "bob", confidence: 0.8 },
			[m1, m2],
		);
		// Lower-confidence observation should NOT regress.
		await fx.service.upsertIdentity(
			entityId,
			{ platform: "twitter", handle: "bob", confidence: 0.3 },
			[m2],
		);

		const identities = await fx.service.getEntityIdentities(entityId);
		expect(identities).toHaveLength(1);
		expect(identities[0].confidence).toBeCloseTo(0.8, 5);
		expect(identities[0].evidenceMessageIds.sort()).toEqual([m1, m2].sort());
	});

	it("proposeMerge + acceptMerge folds B's identities into A and drops B", async () => {
		const entityA = await fx.makeEntity("Carol-Personal");
		const entityB = await fx.makeEntity("Carol-Work");

		await fx.service.upsertIdentity(
			entityA,
			{ platform: "discord", handle: "carol#1", confidence: 0.7 },
			[asUUID(stringToUuid("evd-1"))],
		);
		await fx.service.upsertIdentity(
			entityB,
			{ platform: "github", handle: "carolwork", confidence: 0.7 },
			[asUUID(stringToUuid("evd-2"))],
		);

		const candidateId = await fx.service.proposeMerge(entityA, entityB, {
			notes: "manual link",
		});
		const beforeAccept = await fx.service.getCandidateMerges();
		expect(beforeAccept).toHaveLength(1);
		expect(beforeAccept[0].id).toBe(candidateId);

		await fx.service.acceptMerge(candidateId);

		const aIdentities = await fx.service.getEntityIdentities(entityA);
		expect(aIdentities.map((row) => row.platform).sort()).toEqual(
			["discord", "github"].sort(),
		);
		const bIdentities = await fx.service.getEntityIdentities(entityB);
		expect(bIdentities).toHaveLength(0);

		const afterAccept = await fx.service.getCandidateMerges();
		expect(afterAccept).toHaveLength(0);
	});

	it("rejectMerge leaves both entities intact", async () => {
		const entityA = await fx.makeEntity("Dan-A");
		const entityB = await fx.makeEntity("Dan-B");
		await fx.service.upsertIdentity(
			entityA,
			{ platform: "telegram", handle: "@dana", confidence: 0.7 },
			[],
		);
		await fx.service.upsertIdentity(
			entityB,
			{ platform: "telegram", handle: "@danb", confidence: 0.7 },
			[],
		);

		const candidateId = await fx.service.proposeMerge(entityA, entityB, {});
		await fx.service.rejectMerge(candidateId);

		const aIdentities = await fx.service.getEntityIdentities(entityA);
		expect(aIdentities).toHaveLength(1);
		const bIdentities = await fx.service.getEntityIdentities(entityB);
		expect(bIdentities).toHaveLength(1);

		const pending = await fx.service.getCandidateMerges();
		expect(pending).toHaveLength(0);
	});

	it("auto-merges when high confidence + >= 2 evidence messages collide on (platform, handle)", async () => {
		const entityA = await fx.makeEntity("Eve-Old");
		const entityB = await fx.makeEntity("Eve-New");

		// Seed entity A with an existing observation of @eve.
		await fx.service.upsertIdentity(
			entityA,
			{ platform: "twitter", handle: "eve", confidence: 0.9 },
			[asUUID(stringToUuid("seed-1")), asUUID(stringToUuid("seed-2"))],
		);

		// Now observe the same identity for entity B at >= 0.85 with >= 2 evidence.
		// The newly-upserted entity (B) is the surviving side of the auto-merge:
		// upsertIdentity sees the existing pin on A and folds A into B.
		await fx.service.upsertIdentity(
			entityB,
			{ platform: "twitter", handle: "eve", confidence: 0.9 },
			[asUUID(stringToUuid("evd-3")), asUUID(stringToUuid("evd-4"))],
		);

		// Auto-merge should have folded A into B. A's identities should be empty.
		const bIdentities = await fx.service.getEntityIdentities(entityB);
		expect(bIdentities).toHaveLength(1);
		expect(bIdentities[0].platform).toBe("twitter");
		expect(bIdentities[0].handle).toBe("eve");

		const aIdentities = await fx.service.getEntityIdentities(entityA);
		expect(aIdentities).toHaveLength(0);

		// The auto-accepted candidate should not show up as pending.
		const pending = await fx.service.getCandidateMerges();
		expect(pending).toHaveLength(0);
	});

	it("resolves confirmed identity links into one member cluster", async () => {
		const telegramEntity = await fx.makeEntity("Frank-Telegram");
		const discordEntity = await fx.makeEntity("Frank-Discord");

		await fx.runtime.createRelationship({
			sourceEntityId: telegramEntity,
			targetEntityId: discordEntity,
			tags: ["identity_link"],
			metadata: {
				status: "confirmed",
				source: "test",
			},
		});

		const members = await fx.service.getMemberEntityIds(discordEntity);
		expect(new Set(members)).toEqual(new Set([telegramEntity, discordEntity]));
	});

	it("loads recent interactions from rooms used by linked identities", async () => {
		const telegramEntity = await fx.makeEntity("Grace-Telegram");
		const discordEntity = await fx.makeEntity("Grace-Discord");
		const telegramRoomId = asUUID(stringToUuid("grace-telegram-room"));
		const discordRoomId = asUUID(stringToUuid("grace-discord-room"));
		const telegramWorldId = asUUID(stringToUuid("grace-telegram-world"));
		const discordWorldId = asUUID(stringToUuid("grace-discord-world"));

		await fx.runtime.ensureConnection({
			entityId: telegramEntity,
			roomId: telegramRoomId,
			roomName: "Telegram DM",
			name: "Grace",
			userName: "grace_tg",
			source: "telegram",
			channelId: "telegram-grace",
			type: "DM",
			worldId: telegramWorldId,
			worldName: "Telegram",
		});
		await fx.runtime.ensureConnection({
			entityId: discordEntity,
			roomId: discordRoomId,
			roomName: "Discord DM",
			name: "Grace",
			userName: "grace_discord",
			source: "discord",
			channelId: "discord-grace",
			type: "DM",
			worldId: discordWorldId,
			worldName: "Discord",
		});
		await fx.runtime.createRelationship({
			sourceEntityId: telegramEntity,
			targetEntityId: discordEntity,
			tags: ["identity_link"],
			metadata: {
				status: "confirmed",
				source: "test",
			},
		});

		const previousMessageId = asUUID(
			stringToUuid("grace-telegram-previous-message"),
		);
		await fx.runtime.createMemory(
			{
				id: previousMessageId,
				entityId: telegramEntity,
				agentId: fx.runtime.agentId,
				roomId: telegramRoomId,
				content: {
					text: "My favorite color is green.",
					source: "telegram",
				},
				createdAt: 1,
			},
			"messages",
		);

		const currentMessage: Memory = {
			id: asUUID(stringToUuid("grace-discord-current-message")),
			entityId: discordEntity,
			agentId: fx.runtime.agentId,
			roomId: discordRoomId,
			content: {
				text: "What did I tell you before?",
				source: "discord",
			},
			createdAt: 2,
		};
		const emptyState: State = { values: {}, data: {}, text: "" };

		const result = await recentMessagesProvider.get(
			fx.runtime,
			currentMessage,
			emptyState,
		);

		expect(result.data?.recentInteractions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: previousMessageId }),
			]),
		);
		expect(result.values?.recentInteractions).toContain(
			"My favorite color is green.",
		);
	});
});
