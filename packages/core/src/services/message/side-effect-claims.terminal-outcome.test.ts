/**
 * Deterministic unit coverage for the delegated-work terminal-outcome
 * recognizers in side-effect-claims.ts: the finished-work claim grammar
 * (assertions fire; questions, negations, and plans pass through), the
 * failure-acknowledgment guard, and the tool-evidence terminal-status
 * markers — pinned to the exact live-incident shapes (2026-08-25,
 * chart-dep-check: a TASKS history result reporting "[interrupted]" with no
 * results, followed by the fabricated "it's finished. it looks like we're
 * using chart.js now." reply). Pure functions; no runtime, no model.
 */
import { describe, expect, it } from "vitest";
import {
	replyAcknowledgesWorkNotFinished,
	replyClaimsFinishedDelegatedWork,
	toolEvidenceReportsTerminalFailure,
	toolEvidenceReportsVerifiedCompletion,
} from "./side-effect-claims";

// The byte-exact fabricated reply from the live incident (tj-f725640b30e703).
const INCIDENT_FABRICATED_REPLY =
	"it's finished. it looks like we're using chart.js now.";
// The first (CONTINUE'd) draft from the same incident.
const INCIDENT_FIRST_DRAFT =
	"it's actually all finished. the session chart-dep-check stopped a few minutes ago.\n\nwant me to dig into the results and let you know what we're using for charts now?";
// The TASKS history tool text the reply contradicted.
const INCIDENT_TASKS_HISTORY_TEXT =
	'The most recent orchestrator task is "Chart Dependency Investigation" [interrupted].\n' +
	"Task id: cb6820c6-fc7d-4068-9f33-11f281e24305\n" +
	"Latest session: chart-dep-check\n" +
	"Workspace: /home/milady/.eliza/workspaces/task-4b374a1a\n" +
	"Latest activity: 2026-08-25T08:06:12.157Z";

describe("replyClaimsFinishedDelegatedWork", () => {
	it("fires on the incident's fabricated reply and its first draft", () => {
		expect(replyClaimsFinishedDelegatedWork(INCIDENT_FABRICATED_REPLY)).toBe(
			true,
		);
		expect(replyClaimsFinishedDelegatedWork(INCIDENT_FIRST_DRAFT)).toBe(true);
	});

	it("fires on noun-subject and blanket completion assertions", () => {
		expect(replyClaimsFinishedDelegatedWork("the build is done.")).toBe(true);
		expect(
			replyClaimsFinishedDelegatedWork(
				"the chart-dep-check session is complete.",
			),
		).toBe(true);
		expect(replyClaimsFinishedDelegatedWork("the build finished.")).toBe(true);
		expect(replyClaimsFinishedDelegatedWork("the tests passed.")).toBe(true);
		expect(
			replyClaimsFinishedDelegatedWork("the build completed successfully."),
		).toBe(true);
		expect(replyClaimsFinishedDelegatedWork("All done! anything else?")).toBe(
			true,
		);
	});

	it("passes questions, negations, plans, and progress through", () => {
		expect(replyClaimsFinishedDelegatedWork("is it finished?")).toBe(false);
		expect(replyClaimsFinishedDelegatedWork("it's not finished yet.")).toBe(
			false,
		);
		expect(
			replyClaimsFinishedDelegatedWork("the build hasn't finished yet."),
		).toBe(false);
		expect(
			replyClaimsFinishedDelegatedWork(
				"once it's finished, I'll let you know.",
			),
		).toBe(false);
		expect(
			replyClaimsFinishedDelegatedWork("when it's done I'll ping you."),
		).toBe(false);
		expect(replyClaimsFinishedDelegatedWork("it should be done soon.")).toBe(
			false,
		);
		expect(
			replyClaimsFinishedDelegatedWork("still running — I'll check back."),
		).toBe(false);
	});
});

describe("replyAcknowledgesWorkNotFinished", () => {
	it("recognizes honest failure reports", () => {
		expect(
			replyAcknowledgesWorkNotFinished(
				"that build failed before finishing — want me to retry?",
			),
		).toBe(true);
		expect(replyAcknowledgesWorkNotFinished("it didn't finish.")).toBe(true);
		expect(
			replyAcknowledgesWorkNotFinished(
				"the session was interrupted with no deliverables.",
			),
		).toBe(true);
	});

	it("does not fire on the fabricated completion reply", () => {
		expect(replyAcknowledgesWorkNotFinished(INCIDENT_FABRICATED_REPLY)).toBe(
			false,
		);
	});
});

describe("toolEvidenceReportsTerminalFailure", () => {
	it("returns the [interrupted] status line from the incident's TASKS text", () => {
		const line = toolEvidenceReportsTerminalFailure(
			INCIDENT_TASKS_HISTORY_TEXT,
		);
		expect(line).toBe(
			'The most recent orchestrator task is "Chart Dependency Investigation" [interrupted].',
		);
	});

	it("recognizes verdict JSON and no-deliverable failure phrases", () => {
		expect(
			toolEvidenceReportsTerminalFailure(
				'{ "passed": false, "summary": "The sub-agent failed to produce any deliverables" }',
			),
		).toBeDefined();
		expect(
			toolEvidenceReportsTerminalFailure(
				"I tried to complete that, but the available runtime step failed before it produced a usable result.",
			),
		).toBeDefined();
	});

	it("ignores ordinary prose mentioning failure and unrelated bracketed text", () => {
		expect(
			toolEvidenceReportsTerminalFailure(
				"the rocket launch failed in 1986 according to the article.",
			),
		).toBeUndefined();
		expect(
			toolEvidenceReportsTerminalFailure(
				"markdown checklist: [failed] is one of the allowed labels in this doc.",
			),
		).toBeUndefined();
	});
});

describe("toolEvidenceReportsVerifiedCompletion", () => {
	it("recognizes verified-success status shapes", () => {
		expect(
			toolEvidenceReportsVerifiedCompletion(
				'The most recent orchestrator task is "Chart Dependency Investigation" [done].',
			),
		).toBe(true);
		expect(toolEvidenceReportsVerifiedCompletion('{ "passed": true }')).toBe(
			true,
		);
	});

	it("stays false for the incident's interrupted status", () => {
		expect(
			toolEvidenceReportsVerifiedCompletion(INCIDENT_TASKS_HISTORY_TEXT),
		).toBe(false);
	});
});
