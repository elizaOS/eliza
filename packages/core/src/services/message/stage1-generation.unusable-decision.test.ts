/** Exercises empty RESPOND repair while preserving terminal decisions and pending work. */
import { describe, expect, it } from "vitest";
import { getStage1UnusableDecisionRepair } from "./stage1-generation";

function decision(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		shouldRespond: "RESPOND",
		contexts: ["simple"],
		replyText: "",
		replyEffectStatus: "none",
		requiresTool: false,
		candidateActionNames: [],
		intents: [],
		contextRequests: [],
		...overrides,
	};
}

describe("getStage1UnusableDecisionRepair", () => {
	it.each(["STOP", "IGNORE"])(
		"preserves terminal %s decisions",
		(shouldRespond) => {
			expect(
				getStage1UnusableDecisionRepair(
					decision({ shouldRespond, contexts: [] }),
				),
			).toBeUndefined();
		},
	);

	it.each(["STOP", "IGNORE"])(
		"re-asks a terminal %s once only when the small-model opt-in is set",
		(shouldRespond) => {
			const repair = getStage1UnusableDecisionRepair(
				decision({ shouldRespond, contexts: [] }),
				{ reaskTerminal: true },
			);
			expect(repair).toContain("response_contract_repair:");
			expect(repair).toContain(
				`ended a directly addressed turn with ${shouldRespond}`,
			);
			expect(repair).toContain("use STOP or IGNORE without a reply or actions");
			expect(
				getStage1UnusableDecisionRepair(
					decision({ shouldRespond, contexts: [] }),
					{ reaskTerminal: false },
				),
			).toBeUndefined();
			expect(
				getStage1UnusableDecisionRepair(decision({ replyText: "Santiago." }), {
					reaskTerminal: true,
				}),
			).toBeUndefined();
		},
	);

	it("repairs an empty simple RESPOND", () => {
		expect(
			getStage1UnusableDecisionRepair(decision({ replyText: "   " })),
		).toContain("response_contract_repair:");
	});

	it("leaves real disengage requests, answers, routed work and refusal stubs alone", () => {
		expect(
			getStage1UnusableDecisionRepair(
				decision({ shouldRespond: "STOP", contexts: [] }),
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(decision({ replyText: "Santiago." })),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(
				decision({ contexts: ["calendar"], intents: ["create the event"] }),
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(
				decision({ requiresTool: true, contexts: ["general"] }),
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(
				decision({ contextRequests: ["CONTEXT_CATALOG"] }),
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(decision({ replyText: "I don't know." })),
		).toBeUndefined();
		expect(getStage1UnusableDecisionRepair(null)).toBeUndefined();
	});
});
