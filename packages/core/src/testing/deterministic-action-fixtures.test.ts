/** Tests canonical strict fixtures for every message-loop model decision shape. */

import { describe, expect, it } from "vitest";
import { ModelType } from "../types/model";
import {
	strictClarificationFixture,
	strictEvaluatorFixture,
	strictMultiToolRouteFixtures,
	strictScheduledRenderFixture,
	strictTerminalReplyFixture,
} from "./deterministic-action-fixtures";

describe("strict deterministic action fixtures", () => {
	it("declares ordered multi-tool Stage-1 and planner responses", () => {
		const fixtures = strictMultiToolRouteFixtures({
			input: "Plan and notify",
			tools: [
				{ actionName: "CREATE_PLAN", args: { title: "Launch" } },
				{ actionName: "SEND_MESSAGE", args: { channel: "team" } },
			],
		});
		expect(fixtures).toHaveLength(2);
		expect(fixtures[0]).toMatchObject({
			match: { modelType: ModelType.RESPONSE_HANDLER },
		});
		expect(fixtures[1]).toMatchObject({
			match: {
				modelType: ModelType.ACTION_PLANNER,
				toolNames: ["CREATE_PLAN", "SEND_MESSAGE"],
			},
			response: {
				toolCalls: [{ name: "CREATE_PLAN" }, { name: "SEND_MESSAGE" }],
			},
		});
	});

	it("declares clarification, terminal, evaluator, and scheduled paths", () => {
		expect(
			strictClarificationFixture({ input: "Book it", text: "Which day?" }),
		).toMatchObject({ response: { needsClarification: true } });
		expect(
			strictTerminalReplyFixture({ input: "Hello", text: "Hi!" }),
		).toMatchObject({ response: { candidateActionNames: ["REPLY"] } });
		expect(
			strictEvaluatorFixture({
				name: "evaluate",
				promptIncludes: "score this",
				response: { score: 1 },
			}),
		).toMatchObject({ match: { modelType: ModelType.TEXT_LARGE } });
		expect(
			strictScheduledRenderFixture({
				name: "scheduled",
				promptPrefix: "Render reminder",
				response: "Time to stretch.",
			}),
		).toMatchObject({
			match: {
				modelType: [ModelType.TEXT_SMALL, ModelType.TEXT_LARGE],
			},
		});
	});
});
