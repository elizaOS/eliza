/**
 * Unit tests for the connector-level numeric-fact paraphrase dedup (#15585):
 * the guard that collapses a tool-turn's redundant second bubble (an action
 * relaying the raw value plus the planner restating it as a sentence) at the
 * one point every delivery converges. Pure functions, no Discord client.
 */
import { describe, expect, it } from "vitest";
import {
	isSubsetOrEqual,
	numericFactSignatureTokens,
} from "../messages.ts";

describe("numericFactSignatureTokens (#15585)", () => {
	it("gives a sentence and its bare-value restatement overlapping signatures", () => {
		const sentence = numericFactSignatureTokens(
			"Bitcoin is currently priced at $61,883 USD.",
		);
		const raw = numericFactSignatureTokens("$61,883 USD");
		expect(sentence).not.toBeNull();
		expect(raw).not.toBeNull();
		// The bare value's tokens are a subset of the sentence's — the guard's
		// subset check treats them as the same fact.
		expect(isSubsetOrEqual(raw as Set<string>, sentence as Set<string>)).toBe(
			true,
		);
	});

	it("gives two full-sentence paraphrases signatures in a subset relationship", () => {
		const a = numericFactSignatureTokens(
			"Ethereum is currently priced at $1,727.62 USD.",
		);
		const b = numericFactSignatureTokens(
			"The current price of Ethereum is $1,727.62 USD.",
		);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		const dup =
			isSubsetOrEqual(a as Set<string>, b as Set<string>) ||
			isSubsetOrEqual(b as Set<string>, a as Set<string>);
		expect(dup).toBe(true);
	});

	it("returns null for a reply with no number (never collapses non-numeric answers)", () => {
		expect(numericFactSignatureTokens("Madrid")).toBeNull();
		expect(
			numericFactSignatureTokens("The capital of Spain is Madrid."),
		).toBeNull();
	});

	it("returns null for long replies (never collapses rich content)", () => {
		const long =
			"Current weather in Paris is clear at 22C feeling like 25C with 69% humidity and a light ENE wind, and showers are forecast for later this week across the region.";
		expect(long.length).toBeGreaterThan(160);
		expect(numericFactSignatureTokens(long)).toBeNull();
	});

	it("does NOT collapse replies about different numeric facts", () => {
		const eth = numericFactSignatureTokens("Ethereum is at $1,727 USD.");
		const btc = numericFactSignatureTokens("Bitcoin is at $61,934 USD.");
		expect(eth).not.toBeNull();
		expect(btc).not.toBeNull();
		expect(
			isSubsetOrEqual(eth as Set<string>, btc as Set<string>) ||
				isSubsetOrEqual(btc as Set<string>, eth as Set<string>),
		).toBe(false);
	});

	it("does NOT suppress a follow-up that adds a genuinely new number (directional)", () => {
		const answer = numericFactSignatureTokens("Ethereum is at $1,727 USD.");
		const withChange = numericFactSignatureTokens(
			"Ethereum is at $1,727 USD, up 3 percent today.",
		);
		expect(answer).not.toBeNull();
		expect(withChange).not.toBeNull();
		// The guard suppresses a NEW reply only when its tokens are a subset of a
		// prior one. The additive follow-up carries "3"/"percent"/"today" the
		// answer lacks, so as the new delivery it is NOT a subset → delivered.
		expect(
			isSubsetOrEqual(withChange as Set<string>, answer as Set<string>),
		).toBe(false);
	});

	it("isSubsetOrEqual is directional and correct", () => {
		expect(isSubsetOrEqual(new Set(["a"]), new Set(["a", "b"]))).toBe(true);
		expect(isSubsetOrEqual(new Set(["a", "b"]), new Set(["a"]))).toBe(false);
		expect(isSubsetOrEqual(new Set(["a"]), new Set(["a"]))).toBe(true);
	});
});
