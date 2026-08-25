/**
 * Exercises deterministic capability retrieval directly across tokenization,
 * weighted ranking, ambiguity, limits, metrics, immutability, and invalid input.
 * The suite is deterministic and mock-free.
 */
import { describe, expect, it } from "vitest";
import {
	type CapabilityCatalogEntry,
	retrieveCapabilities,
	tokenizeCapabilityIntent,
} from "./retrieval";

const entry = (
	capabilityId: string,
	overrides: Partial<CapabilityCatalogEntry> = {},
): CapabilityCatalogEntry => ({
	capabilityId,
	domain: "shared",
	summary: "irrelevant capability",
	keywords: [],
	operations: [],
	promptTokenEstimate: 10,
	...overrides,
});

const expectInvalid = (run: () => unknown): void => {
	expect(run).toThrowError(
		expect.objectContaining({
			code: "INVALID_CAPABILITY_RETRIEVAL_INPUT",
			severity: "fatal",
		}),
	);
};

describe("tokenizeCapabilityIntent", () => {
	it("normalizes case and separators while dropping one-character tokens", () => {
		expect(tokenizeCapabilityIntent("Send, E-MAIL_v2 42 send! x")).toEqual([
			"send",
			"mail",
			"v2",
			"42",
			"send",
		]);
	});
});

describe("retrieveCapabilities ranking", () => {
	it("adds keyword, identity, operation, and summary weights once per query token", () => {
		const result = retrieveCapabilities({
			catalog: [
				entry("email.send", {
					domain: "email",
					summary: "Send an email message quickly",
					keywords: ["send"],
					operations: ["send message"],
				}),
			],
			intentText: "SEND send email message",
		});

		expect(result.results).toEqual([
			{
				entry: expect.objectContaining({ capabilityId: "email.send" }),
				score: 14,
				rank: 1,
				matchedTokens: ["email", "message", "send"],
			},
		]);
		expect(result.queryTokens).toEqual(["send", "send", "email", "message"]);
	});

	it("orders by score and uses code-unit capability ids to break ties", () => {
		const result = retrieveCapabilities({
			catalog: [
				entry("summary-only", { summary: "needle" }),
				entry("z-identity-needle"),
				entry("Zulu", { keywords: ["needle"] }),
				entry("alpha", { keywords: ["needle"] }),
				entry("a-operation", { operations: ["needle action"] }),
			],
			intentText: "needle",
		});

		expect(
			result.results.map(({ entry: match, score, rank }) => ({
				capabilityId: match.capabilityId,
				score,
				rank,
			})),
		).toEqual([
			{ capabilityId: "Zulu", score: 3, rank: 1 },
			{ capabilityId: "alpha", score: 3, rank: 2 },
			{ capabilityId: "a-operation", score: 2, rank: 3 },
			{ capabilityId: "z-identity-needle", score: 2, rank: 4 },
			{ capabilityId: "summary-only", score: 1, rank: 5 },
		]);
	});

	it("uses the default bound of five and honors a smaller explicit limit", () => {
		const catalog = Array.from({ length: 7 }, (_, index) =>
			entry(`capability-${index}`, { keywords: ["match"] }),
		);

		expect(
			retrieveCapabilities({ catalog, intentText: "match" }).results.map(
				(match) => match.entry.capabilityId,
			),
		).toEqual(catalog.slice(0, 5).map((candidate) => candidate.capabilityId));
		expect(
			retrieveCapabilities({ catalog, intentText: "match", limit: 1 }).results,
		).toHaveLength(1);
	});

	it("returns designed-empty results for empty and nonmatching inputs", () => {
		expect(retrieveCapabilities({ catalog: [], intentText: "" })).toEqual({
			results: [],
			ambiguity: { ambiguous: false, margin: null, contenders: [] },
			metrics: {
				catalogSize: 0,
				retrievedCount: 0,
				catalogPromptTokenEstimate: 0,
				retrievedPromptTokenEstimate: 0,
				floodRatio: 0,
			},
			queryTokens: [],
		});

		const nonmatch = retrieveCapabilities({
			catalog: [entry("email.send", { promptTokenEstimate: 40 })],
			intentText: "weather forecast",
		});
		expect(nonmatch.results).toEqual([]);
		expect(nonmatch.metrics).toEqual({
			catalogSize: 1,
			retrievedCount: 0,
			catalogPromptTokenEstimate: 40,
			retrievedPromptTokenEstimate: 0,
			floodRatio: 0,
		});
	});

	it("reports metrics for only the retrieved immutable subset", () => {
		const result = retrieveCapabilities({
			catalog: [
				entry("a-match", {
					keywords: ["needle"],
					promptTokenEstimate: 10,
				}),
				entry("b-match", {
					keywords: ["needle"],
					promptTokenEstimate: 30,
				}),
			],
			intentText: "needle",
			limit: 1,
		});

		expect(result.metrics).toEqual({
			catalogSize: 2,
			retrievedCount: 1,
			catalogPromptTokenEstimate: 40,
			retrievedPromptTokenEstimate: 10,
			floodRatio: 0.25,
		});
		expect(result.ambiguity).toEqual({
			ambiguous: false,
			margin: null,
			contenders: [],
		});
		expect(Object.isFrozen(result.results)).toBe(true);
		expect(Object.isFrozen(result.results[0].matchedTokens)).toBe(true);
		expect(Object.isFrozen(result.ambiguity.contenders)).toBe(true);
		expect(Object.isFrozen(result.queryTokens)).toBe(true);
	});
});

describe("retrieveCapabilities ambiguity", () => {
	it("reports equal cross-domain contenders in deterministic order", () => {
		const result = retrieveCapabilities({
			catalog: [
				entry("payments.send", {
					domain: "payments",
					keywords: ["send"],
				}),
				entry("email.send", { domain: "email", keywords: ["send"] }),
			],
			intentText: "send",
		});

		expect(result.ambiguity).toEqual({
			ambiguous: true,
			margin: 0,
			contenders: ["email.send", "payments.send"],
		});
	});

	it("does not report ties within one domain", () => {
		const result = retrieveCapabilities({
			catalog: [
				entry("email.read", { domain: "email", keywords: ["email"] }),
				entry("email.send", { domain: "email", keywords: ["email"] }),
			],
			intentText: "email",
		});

		expect(result.ambiguity).toEqual({
			ambiguous: false,
			margin: 0,
			contenders: [],
		});
	});

	it("uses a strict relative-margin threshold", () => {
		const catalog = [
			entry("alpha", {
				domain: "alpha",
				summary: "needle",
				keywords: ["needle"],
			}),
			entry("beta", {
				domain: "beta",
				summary: "irrelevant",
				keywords: ["needle"],
			}),
		];

		expect(
			retrieveCapabilities({ catalog, intentText: "needle" }).ambiguity,
		).toEqual({ ambiguous: false, margin: 0.25, contenders: [] });
		expect(
			retrieveCapabilities({
				catalog,
				intentText: "needle",
				ambiguityMargin: 0.26,
			}).ambiguity,
		).toEqual({
			ambiguous: true,
			margin: 0.25,
			contenders: ["alpha", "beta"],
		});
	});
});

describe("retrieveCapabilities input validation", () => {
	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid limit %s",
		(limit) => {
			expectInvalid(() =>
				retrieveCapabilities({ catalog: [], intentText: "", limit }),
			);
		},
	);

	it.each([-0.1, 1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid ambiguity margin %s",
		(ambiguityMargin) => {
			expectInvalid(() =>
				retrieveCapabilities({
					catalog: [],
					intentText: "",
					ambiguityMargin,
				}),
			);
		},
	);

	it("rejects empty and duplicate capability ids", () => {
		expectInvalid(() =>
			retrieveCapabilities({ catalog: [entry("  ")], intentText: "" }),
		);
		expectInvalid(() =>
			retrieveCapabilities({
				catalog: [entry("duplicate"), entry("duplicate")],
				intentText: "",
			}),
		);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid prompt token estimate %s", (promptTokenEstimate) => {
		expectInvalid(() =>
			retrieveCapabilities({
				catalog: [entry("invalid", { promptTokenEstimate })],
				intentText: "",
			}),
		);
	});

	it("rejects aggregate prompt token estimates outside the safe range", () => {
		expectInvalid(() =>
			retrieveCapabilities({
				catalog: [
					entry("first", { promptTokenEstimate: Number.MAX_SAFE_INTEGER }),
					entry("second", { promptTokenEstimate: Number.MAX_SAFE_INTEGER }),
				],
				intentText: "",
			}),
		);
	});
});
