/**
 * Evaluation harness for capability retrieval and deterministic account
 * selection. Each corpus case declares expected retrieval (top capability,
 * ambiguity) and selection (selected account or typed denial/unavailable)
 * outcomes; the runner executes the real retrieval and selection paths,
 * records per-case latency and aggregate prompt-token metrics, and returns a
 * deterministic report. Latency is measured but never asserted — assertions
 * belong to the corpus expectations, which are exact.
 */
import { ElizaError } from "../errors";
import type { ConnectedAccount } from "../types/provider-integrations";
import {
	type AccountSelectionIntent,
	type AccountSelectionPolicy,
	type AccountSelectionResult,
	type AccountSelectionSignal,
	selectConnectedAccount,
} from "./account-selection";
import { type CapabilityCatalogEntry, retrieveCapabilities } from "./retrieval";

export interface RetrievalExpectation {
	/** Exact capabilityId expected at rank 1, or null for designed-empty. */
	topCapabilityId: string | null;
	/** Every listed capabilityId must appear in the retrieved set. */
	mustInclude: readonly string[];
	expectAmbiguous: boolean;
}

export type SelectionExpectation =
	| { outcome: "selected"; accountId: string }
	| { outcome: "denied"; reasonCode: string }
	| { outcome: "unavailable"; code: string; retryable: boolean };

export interface CapabilitySelectionEvalCase {
	name: string;
	intentText: string;
	retrieval: RetrievalExpectation;
	/** Null skips the selection stage (retrieval-only case). */
	selection: {
		intent: AccountSelectionIntent;
		accounts: readonly ConnectedAccount[];
		signals: readonly AccountSelectionSignal[];
		policy: AccountSelectionPolicy;
		expected: SelectionExpectation;
	} | null;
}

export interface CapabilitySelectionEvalCaseResult {
	name: string;
	passed: boolean;
	failures: readonly string[];
	retrievedCapabilityIds: readonly string[];
	selection: AccountSelectionResult | null;
	retrievedPromptTokenEstimate: number;
	floodRatio: number;
	latencyMs: number;
}

export interface CapabilitySelectionEvalReport {
	cases: readonly CapabilitySelectionEvalCaseResult[];
	summary: {
		total: number;
		passed: number;
		failed: number;
		meanFloodRatio: number;
		maxRetrievedPromptTokenEstimate: number;
		maxLatencyMs: number;
	};
}

function selectionFailures(
	expected: SelectionExpectation,
	actual: AccountSelectionResult,
): string[] {
	if (expected.outcome !== actual.outcome) {
		return [
			`expected selection outcome ${expected.outcome}, got ${actual.outcome}`,
		];
	}
	const failures: string[] = [];
	if (expected.outcome === "selected" && actual.outcome === "selected") {
		if (actual.account.accountId !== expected.accountId) {
			failures.push(
				`expected account ${expected.accountId}, got ${actual.account.accountId}`,
			);
		}
	}
	if (expected.outcome === "denied" && actual.outcome === "denied") {
		if (actual.reasonCode !== expected.reasonCode) {
			failures.push(
				`expected denial ${expected.reasonCode}, got ${actual.reasonCode}`,
			);
		}
	}
	if (expected.outcome === "unavailable" && actual.outcome === "unavailable") {
		if (actual.code !== expected.code) {
			failures.push(
				`expected unavailable code ${expected.code}, got ${actual.code}`,
			);
		}
		if (actual.retryable !== expected.retryable) {
			failures.push(
				`expected retryable ${expected.retryable}, got ${actual.retryable}`,
			);
		}
	}
	return failures;
}

/**
 * Runs every corpus case against the shared catalog. The report is
 * deterministic apart from latency measurements.
 */
export function runCapabilitySelectionEvaluation(
	catalog: readonly CapabilityCatalogEntry[],
	corpus: readonly CapabilitySelectionEvalCase[],
): CapabilitySelectionEvalReport {
	if (corpus.length === 0) {
		throw new ElizaError("Capability selection evaluation corpus is empty.", {
			code: "INVALID_CAPABILITY_EVALUATION_CORPUS",
			severity: "fatal",
		});
	}
	const names = new Set(corpus.map((evalCase) => evalCase.name));
	if (names.size !== corpus.length) {
		throw new ElizaError(
			"Capability selection evaluation case names must be unique.",
			{
				code: "INVALID_CAPABILITY_EVALUATION_CORPUS",
				severity: "fatal",
			},
		);
	}

	const results: CapabilitySelectionEvalCaseResult[] = corpus.map(
		(evalCase) => {
			const startedAt = performance.now();
			const failures: string[] = [];

			const retrieval = retrieveCapabilities({
				catalog,
				intentText: evalCase.intentText,
			});
			const retrievedCapabilityIds = retrieval.results.map(
				(match) => match.entry.capabilityId,
			);
			const top = retrievedCapabilityIds[0] ?? null;
			if (top !== evalCase.retrieval.topCapabilityId) {
				failures.push(
					`expected top capability ${String(evalCase.retrieval.topCapabilityId)}, got ${String(top)}`,
				);
			}
			for (const required of evalCase.retrieval.mustInclude) {
				if (!retrievedCapabilityIds.includes(required)) {
					failures.push(`expected retrieval to include ${required}`);
				}
			}
			if (
				retrieval.ambiguity.ambiguous !== evalCase.retrieval.expectAmbiguous
			) {
				failures.push(
					`expected ambiguous=${evalCase.retrieval.expectAmbiguous}, got ${retrieval.ambiguity.ambiguous}`,
				);
			}

			let selection: AccountSelectionResult | null = null;
			if (evalCase.selection !== null) {
				selection = selectConnectedAccount(
					evalCase.selection.intent,
					evalCase.selection.accounts,
					evalCase.selection.policy,
					evalCase.selection.signals,
				);
				failures.push(
					...selectionFailures(evalCase.selection.expected, selection),
				);
			}

			return {
				name: evalCase.name,
				passed: failures.length === 0,
				failures: Object.freeze(failures),
				retrievedCapabilityIds: Object.freeze(retrievedCapabilityIds),
				selection,
				retrievedPromptTokenEstimate:
					retrieval.metrics.retrievedPromptTokenEstimate,
				floodRatio: retrieval.metrics.floodRatio,
				latencyMs: performance.now() - startedAt,
			};
		},
	);

	const passed = results.filter((result) => result.passed).length;
	return {
		cases: Object.freeze(results),
		summary: {
			total: results.length,
			passed,
			failed: results.length - passed,
			meanFloodRatio:
				results.reduce((sum, result) => sum + result.floodRatio, 0) /
				results.length,
			maxRetrievedPromptTokenEstimate: Math.max(
				...results.map((result) => result.retrievedPromptTokenEstimate),
			),
			maxLatencyMs: Math.max(...results.map((result) => result.latencyMs)),
		},
	};
}
