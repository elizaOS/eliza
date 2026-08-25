/**
 * Exercises the capability-selection evaluation runner against the real
 * retrieval and account-selection implementations, including validation,
 * expectation diagnostics, immutable case results, and aggregate metrics.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import type { CapabilitySelectionEvalCase } from "./evaluation";
import { runCapabilitySelectionEvaluation } from "./evaluation";
import {
	CAPABILITY_EVALUATION_CATALOG,
	CAPABILITY_EVALUATION_CORPUS,
} from "./evaluation-corpus";

function corpusCase(name: string): CapabilitySelectionEvalCase {
	const evalCase = CAPABILITY_EVALUATION_CORPUS.find(
		(candidate) => candidate.name === name,
	);
	if (evalCase === undefined) {
		throw new Error(`Missing capability-selection corpus case: ${name}`);
	}
	return evalCase;
}

describe("runCapabilitySelectionEvaluation", () => {
	it("runs retrieval-only and selection cases and computes aggregate metrics", () => {
		const selected = corpusCase(
			"unambiguous email send selects the cheapest healthy account",
		);
		const designedEmpty = corpusCase(
			"unrelated intent retrieves nothing instead of the full catalog",
		);
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			[selected, designedEmpty],
		);

		expect(report.cases).toHaveLength(2);
		expect(report.cases[0]).toMatchObject({
			name: selected.name,
			passed: true,
			failures: [],
			selection: {
				outcome: "selected",
				account: { accountId: "acct-email-personal" },
			},
		});
		expect(report.cases[1]).toMatchObject({
			name: designedEmpty.name,
			passed: true,
			failures: [],
			retrievedCapabilityIds: [],
			selection: null,
			retrievedPromptTokenEstimate: 0,
			floodRatio: 0,
		});
		expect(report.summary).toEqual({
			total: 2,
			passed: 2,
			failed: 0,
			meanFloodRatio:
				(report.cases[0].floodRatio + report.cases[1].floodRatio) / 2,
			maxRetrievedPromptTokenEstimate:
				report.cases[0].retrievedPromptTokenEstimate,
			maxLatencyMs: Math.max(...report.cases.map((result) => result.latencyMs)),
		});
		expect(Object.isFrozen(report.cases)).toBe(true);
		expect(
			report.cases.every((result) => Object.isFrozen(result.failures)),
		).toBe(true);
		expect(
			report.cases.every((result) =>
				Object.isFrozen(result.retrievedCapabilityIds),
			),
		).toBe(true);
	});

	it("reports top, inclusion, and ambiguity expectation failures together", () => {
		const ambiguous = corpusCase(
			"ambiguous cross-domain send intent is flagged, never auto-resolved",
		);
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			[
				{
					...ambiguous,
					name: "mismatched retrieval expectations",
					retrieval: {
						topCapabilityId: "calendar.event.create",
						mustInclude: ["payments.transfer.create"],
						expectAmbiguous: false,
					},
				},
			],
		);

		expect(report.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
		expect(report.cases[0].failures).toEqual([
			"expected top capability calendar.event.create, got messaging.chat.send",
			"expected retrieval to include payments.transfer.create",
			"expected ambiguous=false, got true",
		]);
	});

	it("reports a selection outcome mismatch before outcome-specific details", () => {
		const selected = corpusCase(
			"unambiguous email send selects the cheapest healthy account",
		);
		if (selected.selection === null) {
			throw new Error(
				"Expected selected corpus case to include selection input",
			);
		}
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			[
				{
					...selected,
					name: "mismatched selection outcome",
					selection: {
						...selected.selection,
						expected: {
							outcome: "denied",
							reasonCode: "organization_policy_denied",
						},
					},
				},
			],
		);

		expect(report.cases[0].failures).toEqual([
			"expected selection outcome denied, got selected",
		]);
	});

	it("reports an unexpected selected account", () => {
		const selected = corpusCase(
			"unambiguous email send selects the cheapest healthy account",
		);
		if (selected.selection === null) {
			throw new Error(
				"Expected selected corpus case to include selection input",
			);
		}
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			[
				{
					...selected,
					name: "mismatched selected account",
					selection: {
						...selected.selection,
						expected: { outcome: "selected", accountId: "acct-email-work" },
					},
				},
			],
		);

		expect(report.cases[0].failures).toEqual([
			"expected account acct-email-work, got acct-email-personal",
		]);
	});

	it("reports an unexpected denial reason", () => {
		const denied = corpusCase(
			"pinned blocked account is denied, never substituted",
		);
		if (denied.selection === null) {
			throw new Error("Expected denied corpus case to include selection input");
		}
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			[
				{
					...denied,
					name: "mismatched denial reason",
					selection: {
						...denied.selection,
						expected: {
							outcome: "denied",
							reasonCode: "organization_policy_denied",
						},
					},
				},
			],
		);

		expect(report.cases[0].failures).toEqual([
			"expected denial organization_policy_denied, got account_policy_denied",
		]);
	});

	it("reports unexpected unavailable code and retryability independently", () => {
		const unavailable = corpusCase("pinned unknown account is not_configured");
		if (unavailable.selection === null) {
			throw new Error(
				"Expected unavailable corpus case to include selection input",
			);
		}
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			[
				{
					...unavailable,
					name: "mismatched unavailable details",
					selection: {
						...unavailable.selection,
						expected: {
							outcome: "unavailable",
							code: "provider_unavailable",
							retryable: true,
						},
					},
				},
			],
		);

		expect(report.cases[0].failures).toEqual([
			"expected unavailable code provider_unavailable, got not_configured",
			"expected retryable true, got false",
		]);
	});

	it("rejects empty corpora and duplicate case names with a typed error", () => {
		const expectInvalidCorpus = (run: () => unknown): void => {
			expect(run).toThrowError(
				expect.objectContaining({
					code: "INVALID_CAPABILITY_EVALUATION_CORPUS",
					severity: "fatal",
				}),
			);
		};

		expectInvalidCorpus(() =>
			runCapabilitySelectionEvaluation(CAPABILITY_EVALUATION_CATALOG, []),
		);
		const duplicate = corpusCase(
			"unambiguous email send selects the cheapest healthy account",
		);
		expectInvalidCorpus(() =>
			runCapabilitySelectionEvaluation(CAPABILITY_EVALUATION_CATALOG, [
				duplicate,
				duplicate,
			]),
		);
		expect(() =>
			runCapabilitySelectionEvaluation(CAPABILITY_EVALUATION_CATALOG, []),
		).toThrowError(ElizaError);
	});
});
