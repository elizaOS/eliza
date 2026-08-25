/**
 * Verifies the built-in capability-selection evaluation fixtures against the
 * real retrieval and account-selection pipeline. The suite is deterministic
 * and mock-free, and also checks the corpus helpers' normalized defaults.
 */
import { describe, expect, it } from "vitest";
import { runCapabilitySelectionEvaluation } from "./evaluation";
import {
	CAPABILITY_EVALUATION_CATALOG,
	CAPABILITY_EVALUATION_CORPUS,
} from "./evaluation-corpus";

type CorpusCase = (typeof CAPABILITY_EVALUATION_CORPUS)[number];

function selectionFor(name: string): NonNullable<CorpusCase["selection"]> {
	const evalCase = CAPABILITY_EVALUATION_CORPUS.find(
		(candidate) => candidate.name === name,
	);
	if (evalCase === undefined || evalCase.selection === null) {
		throw new Error(`Expected a selection fixture named ${name}`);
	}
	return evalCase.selection;
}

describe("capability evaluation catalog", () => {
	it("provides the complete ordered cross-domain capability set", () => {
		expect(
			CAPABILITY_EVALUATION_CATALOG.map(({ capabilityId, domain }) => ({
				capabilityId,
				domain,
			})),
		).toEqual([
			{ capabilityId: "email.message.send", domain: "email" },
			{ capabilityId: "email.message.search", domain: "email" },
			{ capabilityId: "calendar.event.create", domain: "calendar" },
			{ capabilityId: "messaging.chat.send", domain: "messaging" },
			{ capabilityId: "files.document.search", domain: "files" },
			{ capabilityId: "payments.transfer.create", domain: "payments" },
			{ capabilityId: "contacts.person.search", domain: "contacts" },
			{ capabilityId: "commerce.order.create", domain: "commerce" },
			{ capabilityId: "health.metrics.read", domain: "health" },
			{ capabilityId: "code.repository.search", domain: "code" },
		]);
		expect(
			new Set(CAPABILITY_EVALUATION_CATALOG.map((entry) => entry.capabilityId))
				.size,
		).toBe(CAPABILITY_EVALUATION_CATALOG.length);
		expect(
			CAPABILITY_EVALUATION_CATALOG.every(
				(entry) =>
					entry.keywords.length > 0 &&
					entry.operations.length > 0 &&
					entry.promptTokenEstimate > 0,
			),
		).toBe(true);
	});

	it("keeps the exported fixture collections immutable", () => {
		expect(Object.isFrozen(CAPABILITY_EVALUATION_CATALOG)).toBe(true);
		expect(Object.isFrozen(CAPABILITY_EVALUATION_CORPUS)).toBe(true);

		const cheapest = selectionFor(
			"unambiguous email send selects the cheapest healthy account",
		);
		expect(cheapest.accounts.every((account) => Object.isFrozen(account))).toBe(
			true,
		);
		expect(
			cheapest.accounts.every((account) =>
				Object.isFrozen(account.capabilities),
			),
		).toBe(true);
	});
});

describe("capability evaluation corpus", () => {
	it("passes every declared scenario through the real evaluation pipeline", () => {
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			CAPABILITY_EVALUATION_CORPUS,
		);

		expect(report.summary).toMatchObject({ total: 12, passed: 12, failed: 0 });
		expect(report.cases.every((result) => result.failures.length === 0)).toBe(
			true,
		);
		expect(
			report.cases.map((result) => result.selection?.outcome ?? null),
		).toEqual([
			"selected",
			"selected",
			null,
			null,
			"denied",
			"unavailable",
			"denied",
			"unavailable",
			"unavailable",
			"selected",
			"unavailable",
			"selected",
		]);
	});

	it("normalizes account and signal defaults while retaining explicit overrides", () => {
		const cheapest = selectionFor(
			"unambiguous email send selects the cheapest healthy account",
		);
		expect(cheapest.accounts[0]).toMatchObject({
			accountId: "acct-email-work",
			providerId: "google-mail",
			mode: "cloud",
			status: "connected",
			displayName: null,
			lastUsedAt: "2026-08-01T00:00:00.000Z",
		});
		expect(cheapest.signals).toEqual([
			{
				accountId: "acct-email-work",
				healthy: true,
				region: "us",
				unitCostMicros: 10,
			},
			{
				accountId: "acct-email-personal",
				healthy: true,
				region: "eu",
				unitCostMicros: 5,
			},
		]);

		const revoked = selectionFor(
			"only-revoked accounts surface account_revoked",
		);
		expect(revoked.accounts[0]).toMatchObject({
			accountId: "acct-email-legacy",
			mode: "cloud",
			status: "revoked",
			lastUsedAt: null,
		});
		expect(revoked.signals[0]).toEqual({
			accountId: "acct-email-legacy",
			healthy: true,
			region: "us",
			unitCostMicros: 10,
		});
	});
});
