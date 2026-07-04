/**
 * Unit tests for PlanningService.createSimplePlan: verifies action selection
 * follows the model's `<response>` actions decision, not keyword-matching on
 * user text. Deterministic — the service runs against stub runtime/state with no
 * live model.
 */
import { describe, expect, it } from "vitest";

import type {
	Content,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { PlanningService } from "./planning-service.ts";

/**
 * #10470: `createSimplePlan` must take its action selection from the model's
 * decision (`responseContent.actions`), not from hardcoded English-keyword
 * matching on the user's text. When the model chose no actions, the documented
 * `<response>` contract treats the turn as a plain REPLY.
 */
function msg(text: string): Memory {
	return { content: { text } } as Memory;
}
function planActions(
	plan: Awaited<ReturnType<PlanningService["createSimplePlan"]>>,
) {
	return plan?.steps.map((step) => step.actionName) ?? null;
}

describe("PlanningService.createSimplePlan — LLM-driven action selection (#10470)", () => {
	const svc = new PlanningService({} as IAgentRuntime);
	const rt = {} as IAgentRuntime;
	const state = {} as State;

	it("respects the model's chosen actions verbatim", async () => {
		const rc = { text: "on it", actions: ["SEARCH", "REPLY"] } as Content;
		const plan = await svc.createSimplePlan(
			rt,
			msg("research dogs and reply"),
			state,
			rc,
		);
		expect(planActions(plan)).toEqual(["SEARCH", "REPLY"]);
	});

	it("defaults to REPLY when the model chose no actions — not a keyword guess", async () => {
		const plan = await svc.createSimplePlan(rt, msg("hello there"), state, {
			text: "hi",
			actions: [],
		} as Content);
		expect(planActions(plan)).toEqual(["REPLY"]);
	});

	it("no longer keyword-routes 'email …' → SEND_EMAIL (now REPLY)", async () => {
		const plan = await svc.createSimplePlan(
			rt,
			msg("email Bob the quarterly report"),
			state,
			undefined,
		);
		expect(planActions(plan)).toEqual(["REPLY"]);
		expect(planActions(plan)).not.toContain("SEND_EMAIL");
	});

	it("no longer keyword-routes 'search/find/analyze' → SEARCH (now REPLY)", async () => {
		for (const text of [
			"search for cats",
			"find the file",
			"please analyze this",
		]) {
			const plan = await svc.createSimplePlan(rt, msg(text), state, undefined);
			expect(planActions(plan)).toEqual(["REPLY"]);
			expect(planActions(plan)).not.toContain("SEARCH");
		}
	});

	it("is i18n-safe: a non-English request with no model actions → REPLY", async () => {
		// "send Bob an email with the report" in Spanish — the old English-keyword
		// path would never have matched 'email'/'send'; the model decides instead.
		const plan = await svc.createSimplePlan(
			rt,
			msg("envíame un correo a Bob con el informe"),
			state,
			undefined,
		);
		expect(planActions(plan)).toEqual(["REPLY"]);
	});
});
