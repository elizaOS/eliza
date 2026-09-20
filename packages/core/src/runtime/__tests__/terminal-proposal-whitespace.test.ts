import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../planner-loop";

describe("terminal proposal evidence", () => {
	it.each([
		"Exact body:\n\nAlpha  beta.\n\tSecond line.",
		"```python\nif ready:\n    run()\n```",
	])(
		"preserves reply formatting for completion evaluation: %s",
		async (reply) => {
			let calls = 0;
			let proposals = 0;
			const result = await runPlannerLoop({
				runtime: {
					useModel: async () => {
						if (calls >= 2) throw new Error("Unexpected planner retry");
						return ++calls === 1
							? {
									text: "",
									toolCalls: [
										{
											id: "read",
											name: "READ",
											arguments: { eliza_turn_scope: "more_work_pending" },
										},
									],
								}
							: {
									text: "",
									toolCalls: [
										{
											id: "reply",
											name: "REPLY",
											arguments: { text: reply, eliza_turn_scope: "final" },
										},
									],
								};
					},
				},
				context: {
					id: "exact-proposal",
					events: [
						{
							id: "stage1",
							type: "message_handler",
							source: "message-service",
							metadata: {
								plan: {
									intents: ["Read and quote the exact original"],
									candidateActions: ["READ"],
								},
							},
						},
					],
				},
				tools: [
					{
						name: "READ",
						description: "Read the original text.",
						parameters: { type: "object", properties: {} },
					},
				],
				executeToolCall: async () => ({
					success: true,
					transcriptVisibility: "internal",
					modelReplyRequired: true,
					data: { readOnlyOperation: true, body: reply },
				}),
				evaluate: async ({ trajectory }) => {
					const proposal = trajectory.context.events?.find(
						(event) =>
							event.type === "segment" &&
							event.segment.label === "terminal_planner_output",
					);
					if (!proposal)
						return {
							success: false,
							decision: "CONTINUE",
							thought: "Quote the original text.",
						};
					if (proposal.type !== "segment")
						throw new Error("Expected reply segment");
					proposals++;
					expect(proposal.segment.content).toBe(
						`planner_terminal_output:\n${reply}\n\nnote: Evaluate whether this user-visible output actually completes the request.`,
					);
					return { success: true, decision: "FINISH", messageToUser: reply };
				},
			});
			expect(proposals).toBe(1);
			expect(result.finalMessage).toBe(reply);
		},
	);
});
