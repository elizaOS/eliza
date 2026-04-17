import { describe, expect, it } from "vitest";
import { asUUID } from "../../../../types/index.ts";
import {
	DEFAULT_CONTACT_WEIGHT,
	rankScored,
	resetMissingServiceWarning,
	resolveContactWeight,
	scoreMessage,
	scoreMessages,
} from "../triage-engine.ts";
import type { MessageRef } from "../types.ts";
import { createFakeRuntime, fakeContact } from "./fake-runtime.ts";

const NOW = 1_700_000_000_000;

function makeMessage(partial: Partial<MessageRef> = {}): MessageRef {
	return {
		id: partial.id ?? `msg-${Math.random().toString(36).slice(2)}`,
		source: partial.source ?? "gmail",
		externalId: partial.externalId ?? "ext-1",
		threadId: partial.threadId,
		from: partial.from ?? { identifier: "jane@example.com" },
		to: partial.to ?? [{ identifier: "me@example.com" }],
		subject: partial.subject,
		snippet: partial.snippet ?? "hi",
		body: partial.body,
		receivedAtMs: partial.receivedAtMs ?? NOW - 2 * 60 * 60 * 1000,
		hasAttachments: partial.hasAttachments ?? false,
		isRead: partial.isRead ?? false,
	};
}

describe("triage-engine: resolveContactWeight", () => {
	it("returns default weight when service is missing", async () => {
		resetMissingServiceWarning();
		const runtime = createFakeRuntime({ noRelationships: true });
		const { weight, contact } = await resolveContactWeight(
			runtime,
			"gmail",
			"x@y.z",
		);
		expect(weight).toBe(DEFAULT_CONTACT_WEIGHT);
		expect(contact).toBeNull();
	});

	it("returns default weight when contact not found", async () => {
		const runtime = createFakeRuntime();
		const { weight } = await resolveContactWeight(
			runtime,
			"gmail",
			"unknown@x.com",
		);
		expect(weight).toBe(DEFAULT_CONTACT_WEIGHT);
	});

	it("maps categories to weights (family=1.0)", async () => {
		const contactsByHandle = new Map();
		const contact = fakeContact(asUUID("11111111-1111-1111-1111-111111111111"), [
			"family",
		]);
		contactsByHandle.set("gmail|mom@example.com", contact);
		const runtime = createFakeRuntime({ contactsByHandle });
		const { weight } = await resolveContactWeight(
			runtime,
			"gmail",
			"mom@example.com",
		);
		expect(weight).toBe(1.0);
	});

	it("picks the highest-weight category when multiple present", async () => {
		const contactsByHandle = new Map();
		contactsByHandle.set(
			"telegram|@coworker",
			fakeContact(asUUID("22222222-2222-2222-2222-222222222222"), [
				"acquaintance",
				"professional",
			]),
		);
		const runtime = createFakeRuntime({ contactsByHandle });
		const { weight } = await resolveContactWeight(
			runtime,
			"telegram",
			"@coworker",
		);
		expect(weight).toBe(0.7);
	});
});

describe("triage-engine: scoreMessage", () => {
	it("assigns spam priority to promotional bulk messages", async () => {
		const runtime = createFakeRuntime();
		const msg = makeMessage({
			subject: "Limited time offer — act now",
			snippet: "Click here to unsubscribe from our newsletter",
			body: "marketing blast — unsubscribe link below",
		});
		const score = await scoreMessage(runtime, msg, { nowMs: NOW });
		expect(score.priority).toBe("spam");
		expect(score.suggestedAction).toBe("skip");
	});

	it("floors recent (<1h) messages to at least high priority", async () => {
		const runtime = createFakeRuntime();
		const msg = makeMessage({
			snippet: "hey",
			receivedAtMs: NOW - 10 * 60 * 1000, // 10 minutes ago
		});
		const score = await scoreMessage(runtime, msg, { nowMs: NOW });
		expect(["high", "critical"]).toContain(score.priority);
	});

	it("collects urgency keywords and applies bump (capped)", async () => {
		const runtime = createFakeRuntime();
		const msg = makeMessage({
			subject: "URGENT: deadline today",
			snippet: "need help ASAP",
			receivedAtMs: NOW - 48 * 60 * 60 * 1000, // 2 days ago — past recency floor
		});
		const score = await scoreMessage(runtime, msg, { nowMs: NOW });
		expect(score.urgencyKeywords.length).toBeGreaterThanOrEqual(3);
		expect(score.priority === "high" || score.priority === "critical").toBe(
			true,
		);
	});

	it("bumps priority when user has previously replied in the thread", async () => {
		const runtime = createFakeRuntime();
		const msg = makeMessage({
			snippet: "ok",
			threadId: "thread-1",
			receivedAtMs: NOW - 48 * 60 * 60 * 1000,
		});
		const noContext = await scoreMessage(runtime, msg, { nowMs: NOW });
		const withContext = await scoreMessage(runtime, msg, {
			nowMs: NOW,
			userRepliedThreadIds: new Set(["thread-1"]),
		});
		const order = ["low", "medium", "high", "critical"] as const;
		const idxA = order.indexOf(noContext.priority as (typeof order)[number]);
		const idxB = order.indexOf(withContext.priority as (typeof order)[number]);
		expect(idxB).toBeGreaterThanOrEqual(idxA);
	});

	it("family-weighted messages beat stranger-weighted ones in ranking", async () => {
		const contactsByHandle = new Map();
		contactsByHandle.set(
			"gmail|mom@example.com",
			fakeContact(asUUID("33333333-3333-3333-3333-333333333333"), ["family"]),
		);
		const runtime = createFakeRuntime({ contactsByHandle });
		const family = makeMessage({
			id: "m-family",
			from: { identifier: "mom@example.com" },
			snippet: "hi",
			receivedAtMs: NOW - 48 * 60 * 60 * 1000,
		});
		const stranger = makeMessage({
			id: "m-stranger",
			from: { identifier: "unknown@x.com" },
			snippet: "hi",
			receivedAtMs: NOW - 48 * 60 * 60 * 1000,
		});
		const scored = await scoreMessages(runtime, [stranger, family], {
			nowMs: NOW,
		});
		const ranked = rankScored(scored);
		expect(ranked[0].id).toBe("m-family");
	});
});
