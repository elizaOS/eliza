/**
 * Rolodex extension tests (T7b).
 *
 * Uses a real PGLite-backed runtime (plugin-sql). No SQL mocks.
 * Covers:
 *   - findByHandle round-trip
 *   - recordInteraction + lastInteractionAt update
 *   - mergeContacts consolidation
 *   - listOverdueFollowups threshold math
 *   - setRelationshipGoal + getRelationshipProgress cadence health
 *   - importContactsFromPlatform dedupe
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCharacter } from "../character.ts";
import { AgentRuntime } from "../runtime.ts";
import type { RelationshipsService } from "../services/relationships.ts";
import { asUUID } from "../types/primitives.ts";
import { stringToUuid } from "../utils.ts";

interface Fixture {
	runtime: AgentRuntime;
	service: RelationshipsService;
	cleanup: () => Promise<void>;
	makeEntity: (displayName: string) => Promise<ReturnType<typeof asUUID>>;
}

async function setup(): Promise<Fixture> {
	const pgliteDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "rolodex-test-pglite-"),
	);
	const prevPgliteDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = pgliteDir;

	const character = createCharacter({ name: "RolodexTestAgent" });
	const runtime = new AgentRuntime({
		character,
		plugins: [],
		logLevel: "warn",
		enableAutonomy: false,
	});

	const { default: pluginSql } = await import("@elizaos/plugin-sql");
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();

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

	// Service registration is lazy; ensure start before test.
	const service = (await runtime.getServiceLoadPromise(
		"relationships",
	)) as RelationshipsService;

	const makeEntity = async (displayName: string) => {
		const entityId = asUUID(
			stringToUuid(`rolodex-test-${displayName}-${Math.random()}`),
		);
		await runtime.createEntity({
			id: entityId,
			names: [displayName],
			agentId: runtime.agentId,
		});
		return entityId;
	};

	return { runtime, service, cleanup, makeEntity };
}

describe("RelationshipsService rolodex extensions (T7b)", () => {
	let fx: Fixture;

	beforeEach(async () => {
		fx = await setup();
	});

	afterEach(async () => {
		await fx.cleanup();
	});

	it("findByHandle round-trips by (platform, identifier)", async () => {
		const entityId = await fx.makeEntity("Alice");
		await fx.service.addContact(entityId, ["friend"], {}, {
			displayName: "Alice",
		});
		await fx.service.addHandle(entityId, {
			platform: "discord",
			identifier: "Alice#1234",
			isPrimary: true,
		});

		const found = await fx.service.findByHandle("discord", "alice#1234");
		expect(found).not.toBeNull();
		expect(found?.entityId).toBe(entityId);

		const notFound = await fx.service.findByHandle("discord", "nobody");
		expect(notFound).toBeNull();

		const wrongPlatform = await fx.service.findByHandle(
			"telegram",
			"Alice#1234",
		);
		expect(wrongPlatform).toBeNull();
	});

	it("recordInteraction updates lastInteractionAt and bounds history", async () => {
		const entityId = await fx.makeEntity("Bob");
		await fx.service.addContact(entityId, ["friend"], {}, {
			displayName: "Bob",
		});

		const earlier = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
		const later = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();

		await fx.service.recordInteraction({
			contactId: entityId,
			platform: "telegram",
			direction: "outbound",
			occurredAt: earlier,
			summary: "first ping",
		});
		const afterFirst = await fx.service.getContact(entityId);
		expect(afterFirst?.lastInteractionAt).toBe(earlier);
		expect(afterFirst?.interactions).toHaveLength(1);

		await fx.service.recordInteraction({
			contactId: entityId,
			platform: "telegram",
			direction: "inbound",
			occurredAt: later,
			summary: "reply",
		});
		const afterSecond = await fx.service.getContact(entityId);
		expect(afterSecond?.lastInteractionAt).toBe(later);
		expect(afterSecond?.interactions).toHaveLength(2);

		// An older interaction must not regress lastInteractionAt
		await fx.service.recordInteraction({
			contactId: entityId,
			platform: "telegram",
			direction: "inbound",
			occurredAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
		});
		const afterThird = await fx.service.getContact(entityId);
		expect(afterThird?.lastInteractionAt).toBe(later);
	});

	it("mergeContacts consolidates handles, interactions, categories", async () => {
		const primaryId = await fx.makeEntity("Carol-Primary");
		const secondaryId = await fx.makeEntity("Carol-Secondary");

		await fx.service.addContact(primaryId, ["friend"], {}, {
			displayName: "Carol",
		});
		await fx.service.addContact(secondaryId, ["colleague"], {}, {
			displayName: "Carol Work",
		});

		await fx.service.addHandle(primaryId, {
			platform: "gmail",
			identifier: "carol@example.com",
		});
		await fx.service.addHandle(secondaryId, {
			platform: "discord",
			identifier: "carol#42",
		});

		const t1 = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
		const t2 = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
		await fx.service.recordInteraction({
			contactId: primaryId,
			platform: "gmail",
			direction: "outbound",
			occurredAt: t1,
		});
		await fx.service.recordInteraction({
			contactId: secondaryId,
			platform: "discord",
			direction: "inbound",
			occurredAt: t2,
		});

		const merged = await fx.service.mergeContacts(primaryId, secondaryId);

		expect(merged.handles).toHaveLength(2);
		const platforms = merged.handles.map((h) => h.platform).sort();
		expect(platforms).toEqual(["discord", "gmail"]);
		expect(merged.interactions).toHaveLength(2);
		expect(merged.categories).toEqual(
			expect.arrayContaining(["friend", "colleague"]),
		);
		expect(merged.lastInteractionAt).toBe(t2);

		// Secondary must be gone
		expect(await fx.service.getContact(secondaryId)).toBeNull();
	});

	it("listOverdueFollowups respects threshold and asOf", async () => {
		const freshId = await fx.makeEntity("Fresh");
		const staleId = await fx.makeEntity("Stale");
		const neverId = await fx.makeEntity("Never");

		await fx.service.addContact(freshId);
		await fx.service.addContact(staleId);
		await fx.service.addContact(neverId);

		const now = Date.now();
		// 3 days ago — within 7-day threshold
		await fx.service.recordInteraction({
			contactId: freshId,
			platform: "telegram",
			direction: "outbound",
			occurredAt: new Date(now - 3 * 24 * 3600 * 1000).toISOString(),
		});
		// 20 days ago — beyond 7-day threshold
		await fx.service.recordInteraction({
			contactId: staleId,
			platform: "telegram",
			direction: "outbound",
			occurredAt: new Date(now - 20 * 24 * 3600 * 1000).toISOString(),
		});

		await fx.service.updateContact(freshId, { followupThresholdDays: 7 });
		await fx.service.updateContact(staleId, { followupThresholdDays: 7 });
		await fx.service.updateContact(neverId, { followupThresholdDays: 7 });

		const overdue = await fx.service.listOverdueFollowups({ asOfMs: now });
		const ids = overdue.map((o) => o.contact.entityId);
		expect(ids).toContain(staleId);
		expect(ids).toContain(neverId);
		expect(ids).not.toContain(freshId);

		// Never-contacted sorts first (infinite days)
		expect(overdue[0].contact.entityId).toBe(neverId);
	});

	it("setRelationshipGoal + getRelationshipProgress computes cadenceHealth", async () => {
		const entityId = await fx.makeEntity("Dana");
		await fx.service.addContact(entityId);

		const progressBefore =
			await fx.service.getRelationshipProgress(entityId);
		expect(progressBefore?.cadenceHealth).toBe("no-goal");

		await fx.service.setRelationshipGoal(entityId, {
			goalText: "Keep in touch monthly",
			targetCadenceDays: 30,
		});

		const progressNoInteraction =
			await fx.service.getRelationshipProgress(entityId);
		expect(progressNoInteraction?.cadenceHealth).toBe("never-contacted");
		expect(progressNoInteraction?.targetCadenceDays).toBe(30);

		await fx.service.recordInteraction({
			contactId: entityId,
			platform: "gmail",
			direction: "outbound",
			occurredAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
		});
		const progressOnTrack =
			await fx.service.getRelationshipProgress(entityId);
		expect(progressOnTrack?.cadenceHealth).toBe("on-track");

		await fx.service.recordInteraction({
			contactId: entityId,
			platform: "gmail",
			direction: "outbound",
			occurredAt: new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString(),
		});
		// lastInteractionAt should not regress; still on-track
		const stillOnTrack =
			await fx.service.getRelationshipProgress(entityId);
		expect(stillOnTrack?.cadenceHealth).toBe("on-track");
	});

	it("importContactsFromPlatform dedupes by existing handle", async () => {
		const existingId = await fx.makeEntity("Existing");
		await fx.service.addContact(existingId);
		await fx.service.addHandle(existingId, {
			platform: "discord",
			identifier: "existing#1",
		});

		const result = await fx.service.importContactsFromPlatform("discord", [
			{
				platform: "discord",
				identifier: "existing#1",
				displayName: "Existing User",
			},
			{
				platform: "discord",
				identifier: "new-friend#7",
				displayName: "New Friend",
				tags: ["imported"],
			},
			{
				platform: "discord",
				identifier: "",
				displayName: "Broken",
			},
		]);

		expect(result.linkedToExisting).toHaveLength(1);
		expect(result.linkedToExisting[0].entityId).toBe(existingId);
		expect(result.imported).toHaveLength(1);
		expect(result.imported[0].handles[0].identifier).toBe("new-friend#7");
		expect(result.imported[0].tags).toContain("imported");
		expect(result.skipped).toHaveLength(1);

		// findByHandle now finds the newly imported contact
		const newOne = await fx.service.findByHandle(
			"discord",
			"new-friend#7",
		);
		expect(newOne).not.toBeNull();
	});
});
