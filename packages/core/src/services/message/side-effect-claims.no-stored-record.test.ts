/**
 * Deterministic unit coverage for the stored-record absence-claim
 * recognizers in side-effect-claims.ts: the absence-claim grammar
 * (assertions with a checkable topic fire; questions, conditionals, and
 * pronoun-only topics pass through), the FACTS evidence-line matcher, and
 * the user-facing fact projection — pinned to the exact live-incident
 * shapes (2026-08-21, tj-8f5d420d19288f: a FACTS block carrying "[durable.
 * preference conf=0.95] user's favorite planet is saturn" contradicted by
 * the fabricated reply "i don't have a record of a favorite planet for you
 * anymore."). Pure functions; no runtime, no model.
 */
import { describe, expect, it } from "vitest";
import {
	factEvidenceUserText,
	factsEvidenceLineForClaimTopic,
	replyClaimsNoStoredRecordOfTopic,
} from "./side-effect-claims";

// The byte-exact fabricated denial from the live incident (tj-8f5d420d19288f).
const INCIDENT_FABRICATED_REPLY =
	"i don't have a record of a favorite planet for you anymore.";
// The byte-exact FACTS provider text the reply contradicted (same turn's
// prompt, rendered as provider:FACTS:).
const INCIDENT_FACTS_TEXT =
	"Standing preferences the speaker has expressed (apply any that are relevant to this reply):\n" +
	"[durable.preference conf=0.95] user's favorite planet is saturn\n" +
	"[durable.preference conf=0.95] user's favorite color is orange\n" +
	"[durable.preference conf=0.95] user's favorite switch type is gateron oil kings\n" +
	"\n" +
	"What's currently happening for the speaker:\n" +
	"[current.uncategorized since 2026-08-26 conf=0.60] favorite planet is saturn\n" +
	"\n" +
	"Known facts in this room (about other participants):\n" +
	"[durable.fact conf=0.95] user's garage code is 4482\n" +
	"\n" +
	"What's currently happening in this room:\n" +
	"[current.uncategorized since 2026-08-12 conf=0.60] the develop branch in elizaos/eliza GitHub is the only source of truth for docs\n" +
	"[current.uncategorized since 2026-08-12 conf=0.60] the develop branch of the elizaos/eliza github repository is the only source of truth for current development";

describe("replyClaimsNoStoredRecordOfTopic", () => {
	it("fires on the incident's fabricated denial with the topic's content tokens", () => {
		const claims = replyClaimsNoStoredRecordOfTopic(INCIDENT_FABRICATED_REPLY);
		expect(claims).toHaveLength(1);
		expect(claims[0]?.topicTokens).toEqual(["favorite", "planet"]);
	});

	it("fires on the other assertion shapes", () => {
		expect(
			replyClaimsNoStoredRecordOfTopic("i have no memory of your birthday."),
		).toHaveLength(1);
		expect(
			replyClaimsNoStoredRecordOfTopic(
				"we no longer have a note about the garage code.",
			),
		).toHaveLength(1);
		expect(
			replyClaimsNoStoredRecordOfTopic("there's no record of a dog's name."),
		).toHaveLength(1);
		expect(
			replyClaimsNoStoredRecordOfTopic(
				"nothing is stored about your commute route.",
			),
		).toHaveLength(1);
	});

	it("passes questions, conditionals, and pronoun-only topics through", () => {
		expect(
			replyClaimsNoStoredRecordOfTopic(
				"do i have a record of your favorite planet?",
			),
		).toHaveLength(0);
		expect(
			replyClaimsNoStoredRecordOfTopic(
				"if there's no record of your birthday, i can save it.",
			),
		).toHaveLength(0);
		// No checkable topic survives stopword stripping.
		expect(
			replyClaimsNoStoredRecordOfTopic("i don't have a record of that."),
		).toHaveLength(0);
	});

	it("passes ordinary prose without a store noun through", () => {
		expect(
			replyClaimsNoStoredRecordOfTopic("i don't have a favorite planet."),
		).toHaveLength(0);
		expect(
			replyClaimsNoStoredRecordOfTopic("saturn is your favorite planet."),
		).toHaveLength(0);
	});
});

describe("factsEvidenceLineForClaimTopic", () => {
	it("returns the incident's durable fact line for the incident topic", () => {
		expect(
			factsEvidenceLineForClaimTopic(INCIDENT_FACTS_TEXT, [
				"favorite",
				"planet",
			]),
		).toBe("[durable.preference conf=0.95] user's favorite planet is saturn");
	});

	it("returns undefined when no fact line carries every topic token", () => {
		expect(
			factsEvidenceLineForClaimTopic(INCIDENT_FACTS_TEXT, ["dog", "name"]),
		).toBeUndefined();
	});

	it("never treats an unmarked prose line as fact evidence", () => {
		// The header names "preferences" and "speaker" but carries no
		// [durable.…]/[current.…] marker, so it is not a stored-fact line.
		expect(
			factsEvidenceLineForClaimTopic(
				"Standing preferences the speaker has expressed about a favorite planet:",
				["favorite", "planet"],
			),
		).toBeUndefined();
	});

	it("matches whole words only", () => {
		expect(
			factsEvidenceLineForClaimTopic(
				"[durable.fact conf=0.95] user's planetarium membership is active",
				["planet"],
			),
		).toBeUndefined();
	});
});

describe("factEvidenceUserText", () => {
	it("strips the provenance marker from the incident line", () => {
		expect(
			factEvidenceUserText(
				"[durable.preference conf=0.95] user's favorite planet is saturn",
			),
		).toBe("user's favorite planet is saturn");
	});
});
