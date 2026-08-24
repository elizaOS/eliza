/**
 * Branch-coverage supplement to triage-engine.test.ts: exercises the
 * resolveContactWeight fallback paths (missing service, non-function
 * findByHandle, warn-once dedupe), category normalization/max semantics,
 * ScoreContext determinism, scoreMessages ordering guarantees, and the
 * exported compareMessageRefsByRecency total-order edges (non-finite stamps,
 * unscored refs, NaN weights, id tie-break). Deterministic — fake runtime +
 * in-process contacts, no live model, no connector, no DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../../../../logger.ts";
import type { UUID } from "../../../../types/index.ts";
import {
	compareMessageRefsByRecency,
	DEFAULT_CONTACT_WEIGHT,
	rankScored,
	resetMissingServiceWarning,
	resolveContactWeight,
	scoreMessage,
	scoreMessages,
} from "../triage-engine.ts";
import type { MessageRef } from "../types.ts";
import { createFakeRuntime, fakeContact } from "./fake-runtime.ts";

function messageRef(overrides: Partial<MessageRef>): MessageRef {
	return {
		id: "msg",
		source: "gmail",
		externalId: "external-msg",
		from: { identifier: "alice@example.com" },
		to: [{ identifier: "owner@example.com" }],
		snippet: "hello",
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

function contactFor(
	n: number,
	categories: string[],
): ReturnType<typeof fakeContact> {
	return fakeContact(
		`00000000-0000-0000-0000-${String(n).padStart(12, "0")}` as UUID,
		categories,
	);
}

describe("resolveContactWeight fallbacks", () => {
	beforeEach(() => {
		resetMissingServiceWarning();
	});

	it("returns the default weight when no relationships service is registered", async () => {
		const runtime = createFakeRuntime({ noRelationships: true });
		const result = await resolveContactWeight(runtime, "gmail", "a@x.com");
		expect(result).toEqual({
			weight: DEFAULT_CONTACT_WEIGHT,
			contact: null,
		});
	});

	it("returns the default weight when findByHandle is not a function", async () => {
		const runtime = createFakeRuntime({
			availableServices: new Set(["relationships"]),
		});
		const result = await resolveContactWeight(runtime, "gmail", "a@x.com");
		expect(result).toEqual({
			weight: DEFAULT_CONTACT_WEIGHT,
			contact: null,
		});
	});

	it("logs the missing-service warning exactly once across repeated calls", async () => {
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
		try {
			const runtime = createFakeRuntime({ noRelationships: true });
			await resolveContactWeight(runtime, "gmail", "a@x.com");
			await resolveContactWeight(runtime, "gmail", "b@x.com");
			await resolveContactWeight(runtime, "gmail", "c@x.com");
			const engineWarnings = infoSpy.mock.calls.filter((args) =>
				String(args[0]).includes("[TriageEngine]"),
			);
			expect(engineWarnings).toHaveLength(1);
		} finally {
			infoSpy.mockRestore();
		}
	});

	it("resetMissingServiceWarning re-arms the one-time warning", async () => {
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
		try {
			const runtime = createFakeRuntime({ noRelationships: true });
			await resolveContactWeight(runtime, "gmail", "a@x.com");
			resetMissingServiceWarning();
			await resolveContactWeight(runtime, "gmail", "b@x.com");
			const engineWarnings = infoSpy.mock.calls.filter((args) =>
				String(args[0]).includes("[TriageEngine]"),
			);
			expect(engineWarnings).toHaveLength(2);
		} finally {
			infoSpy.mockRestore();
		}
	});
});

describe("resolveContactWeight category resolution", () => {
	beforeEach(() => {
		resetMissingServiceWarning();
	});

	it("normalizes category case and surrounding whitespace before lookup", async () => {
		const contacts = new Map([
			["gmail|mom@example.com", contactFor(1, ["  FAMILY  "])],
			["gmail|friend@example.com", contactFor(2, ["Close-Friend"])],
			["gmail|work@example.com", contactFor(3, [" Work "])],
		]);
		const runtime = createFakeRuntime({ contactsByHandle: contacts });

		expect(
			(await resolveContactWeight(runtime, "gmail", "mom@example.com")).weight,
		).toBe(1.0);
		expect(
			(await resolveContactWeight(runtime, "gmail", "friend@example.com"))
				.weight,
		).toBe(0.9);
		expect(
			(await resolveContactWeight(runtime, "gmail", "work@example.com")).weight,
		).toBe(0.7);
	});

	it("takes the highest qualifying weight across multiple categories", async () => {
		const contacts = new Map([
			[
				"gmail|mixed@example.com",
				contactFor(4, ["stranger", "professional", "acquaintance"]),
			],
		]);
		const runtime = createFakeRuntime({ contactsByHandle: contacts });
		const result = await resolveContactWeight(
			runtime,
			"gmail",
			"mixed@example.com",
		);
		expect(result.weight).toBe(0.7);
		expect(result.contact?.categories).toEqual([
			"stranger",
			"professional",
			"acquaintance",
		]);
	});

	it("ignores unrecognized categories and never lowers below the default", async () => {
		const contacts = new Map([
			["gmail|odd@example.com", contactFor(5, ["nemesis"])],
			["gmail|cold@example.com", contactFor(6, ["stranger"])],
			["gmail|empty@example.com", contactFor(7, [])],
		]);
		const runtime = createFakeRuntime({ contactsByHandle: contacts });

		for (const identifier of [
			"odd@example.com",
			"cold@example.com",
			"empty@example.com",
		]) {
			const result = await resolveContactWeight(runtime, "gmail", identifier);
			expect(result.weight).toBe(DEFAULT_CONTACT_WEIGHT);
			expect(result.contact).not.toBeNull();
		}
	});
});

describe("scoreMessage context handling", () => {
	beforeEach(() => {
		resetMissingServiceWarning();
	});

	it("uses the supplied nowMs for scoredAt instead of the wall clock", async () => {
		const runtime = createFakeRuntime();
		const score = await scoreMessage(runtime, messageRef({ id: "pinned" }), {
			nowMs: 1_234_567_890,
		});
		expect(score.scoredAt).toBe(1_234_567_890);
	});

	it("marks userRepliedInThread false when the thread is absent from the replied set", async () => {
		const runtime = createFakeRuntime();
		const score = await scoreMessage(
			runtime,
			messageRef({ id: "unreplied", threadId: "thread-9" }),
			{ userRepliedThreadIds: new Set(["thread-1", "thread-2"]) },
		);
		expect(score.userRepliedInThread).toBe(false);
	});

	it("marks userRepliedInThread false when the ref has no threadId at all", async () => {
		const runtime = createFakeRuntime();
		const score = await scoreMessage(
			runtime,
			messageRef({ id: "threadless" }),
			{
				userRepliedThreadIds: new Set(["thread-1"]),
			},
		);
		expect(score.userRepliedInThread).toBe(false);
	});
});

describe("scoreMessages batch behavior", () => {
	beforeEach(() => {
		resetMissingServiceWarning();
	});

	it("preserves input order and attaches a triageScore to every ref", async () => {
		const runtime = createFakeRuntime();
		const input = [
			messageRef({ id: "c", externalId: "c", receivedAtMs: 3_000 }),
			messageRef({ id: "a", externalId: "a", receivedAtMs: 1_000 }),
			messageRef({ id: "b", externalId: "b", receivedAtMs: 2_000 }),
		];
		const scored = await scoreMessages(runtime, input, { nowMs: 42 });
		expect(scored.map((m) => m.id)).toEqual(["c", "a", "b"]);
		for (const m of scored) {
			expect(m.triageScore).toMatchObject({
				contactWeight: DEFAULT_CONTACT_WEIGHT,
				userRepliedInThread: false,
				scoredAt: 42,
			});
		}
	});

	it("returns an empty array for an empty inbox without touching services", async () => {
		const runtime = createFakeRuntime({ noRelationships: true });
		const scored = await scoreMessages(runtime, []);
		expect(scored).toEqual([]);
	});
});

describe("rankScored ordering edges", () => {
	beforeEach(() => {
		resetMissingServiceWarning();
	});

	it("does not mutate the input array and returns a fresh ordered copy", () => {
		const older = messageRef({
			id: "older",
			externalId: "o",
			receivedAtMs: 1_000,
		});
		const newer = messageRef({
			id: "newer",
			externalId: "n",
			receivedAtMs: 2_000,
		});
		const input = [older, newer];

		const ranked = rankScored(input);

		expect(ranked).not.toBe(input);
		expect(ranked.map((m) => m.id)).toEqual(["newer", "older"]);
		expect(input.map((m) => m.id)).toEqual(["older", "newer"]);
	});

	it("returns empty for an empty feed and the single element unchanged for one ref", () => {
		expect(rankScored([])).toEqual([]);
		const solo = [messageRef({ id: "only", externalId: "only" })];
		expect(rankScored(solo).map((m) => m.id)).toEqual(["only"]);
	});

	it("treats non-finite receivedAtMs as epoch zero instead of corrupting the order", () => {
		const finite = messageRef({
			id: "finite",
			externalId: "f",
			receivedAtMs: 1_000,
		});
		const negativeButFinite = messageRef({
			id: "negative",
			externalId: "neg",
			receivedAtMs: -5,
		});
		const malformed = messageRef({
			id: "malformed",
			externalId: "nan",
			receivedAtMs: Number.NaN,
		});

		const ranked = rankScored([malformed, negativeButFinite, finite]);
		expect(ranked.map((m) => m.id)).toEqual([
			"finite",
			"malformed",
			"negative",
		]);

		expect(compareMessageRefsByRecency(finite, malformed)).toBeLessThan(0);
		expect(compareMessageRefsByRecency(malformed, finite)).toBeGreaterThan(0);
	});

	it("sorts unscored refs and NaN contactWeights at the default weight, then breaks full ties by id", () => {
		const at = 5_000;
		const influential = messageRef({
			id: "z-influential",
			externalId: "z",
			receivedAtMs: at,
			triageScore: {
				contactWeight: 0.9,
				userRepliedInThread: false,
				scoredAt: at,
			},
		});
		const nanWeight = messageRef({
			id: "a-nan-weight",
			externalId: "a",
			receivedAtMs: at,
			triageScore: {
				contactWeight: Number.NaN,
				userRepliedInThread: false,
				scoredAt: at,
			},
		});
		const unscored = messageRef({
			id: "b-unscored",
			externalId: "b",
			receivedAtMs: at,
		});

		const ranked = rankScored([unscored, nanWeight, influential]);
		expect(ranked.map((m) => m.id)).toEqual([
			"z-influential",
			"a-nan-weight",
			"b-unscored",
		]);

		expect(compareMessageRefsByRecency(nanWeight, unscored)).toBeLessThan(0);
	});

	it("breaks remaining ties by locale-independent code-unit id order", () => {
		const make = (id: string) =>
			messageRef({ id, externalId: id, receivedAtMs: 1_000 });
		const a10 = make("msg10");
		const a2 = make("msg2");

		expect(rankScored([a2, a10]).map((m) => m.id)).toEqual(["msg10", "msg2"]);
		expect(compareMessageRefsByRecency(a10, a2)).toBeLessThan(0);
		expect(compareMessageRefsByRecency(make("dup"), make("dup"))).toBe(0);
	});
});
