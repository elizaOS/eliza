/**
 * Unit coverage for the topics field evaluator and `normalizeTopics`
 * (lowercasing, dedupe, length/count caps, scalar coercion) plus topics
 * threading through `parseMessageHandlerOutput`. Pure, deterministic.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_MESSAGE_TOPICS,
	MAX_TOPIC_LABEL_LENGTH,
	normalizeTopics,
	topicsFieldEvaluator,
} from "../builtin-field-evaluators";
import { parseMessageHandlerOutput } from "../message-handler";

describe("topicsFieldEvaluator.parse / normalizeTopics", () => {
	it("lowercases, trims, and collapses internal whitespace", () => {
		expect(
			topicsFieldEvaluator.parse?.(["  Billing  ", "Auth   Bug"], undefined),
		).toEqual(["billing", "auth bug"]);
	});

	it("dedupes case-insensitively, preserving first occurrence order", () => {
		expect(normalizeTopics(["Billing", "billing", "BILLING", "auth"])).toEqual([
			"billing",
			"auth",
		]);
	});

	it("drops empty / whitespace-only entries", () => {
		expect(normalizeTopics(["", "   ", "vacation", "\t"])).toEqual([
			"vacation",
		]);
	});

	it("drops overlong labels (sentences, not topic labels)", () => {
		const overlong = "x".repeat(MAX_TOPIC_LABEL_LENGTH + 1);
		const atLimit = "y".repeat(MAX_TOPIC_LABEL_LENGTH);
		expect(normalizeTopics([overlong, atLimit, "ok"])).toEqual([atLimit, "ok"]);
	});

	it(`caps the list at ${MAX_MESSAGE_TOPICS} topics`, () => {
		const many = ["a", "b", "c", "d", "e", "f", "g"];
		expect(normalizeTopics(many)).toEqual(["a", "b", "c", "d", "e"]);
		expect(normalizeTopics(many).length).toBe(MAX_MESSAGE_TOPICS);
	});

	it("coerces non-string scalars then re-applies the rules", () => {
		// Defensive: a model may emit numbers; String() + trim still yields a label.
		expect(normalizeTopics([1, "auth", 1])).toEqual(["1", "auth"]);
	});

	it("returns an empty array for non-array / absent input", () => {
		expect(normalizeTopics(undefined)).toEqual([]);
		expect(normalizeTopics(null)).toEqual([]);
		expect(normalizeTopics("billing")).toEqual([]);
		expect(normalizeTopics({ topic: "billing" })).toEqual([]);
		expect(topicsFieldEvaluator.parse?.(undefined, undefined)).toEqual([]);
	});
});

describe("parseMessageHandlerOutput — topics threading", () => {
	it("carries normalized topics through extract", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Sure.",
				contexts: ["simple"],
				topics: ["  Billing ", "billing", "Auth Bug"],
			}),
		);
		expect(parsed?.extract?.topics).toEqual(["billing", "auth bug"]);
	});

	it("omits topics from extract when none are present (backward compatible)", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Sure.",
				contexts: ["simple"],
			}),
		);
		expect(parsed?.extract).toBeUndefined();
	});

	it("does not build an extract when topics is the only (empty) field", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Sure.",
				contexts: ["simple"],
				topics: ["", "   "],
			}),
		);
		expect(parsed?.extract).toBeUndefined();
	});

	it("keeps topics alongside facts/relationships/addressedTo in extract", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["general"],
				facts: ["user lives in Brooklyn"],
				topics: ["moving", "Brooklyn"],
			}),
		);
		expect(parsed?.extract?.facts).toEqual(["user lives in Brooklyn"]);
		expect(parsed?.extract?.topics).toEqual(["moving", "brooklyn"]);
	});
});
