import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import { parseEvaluatorOutput, runEvaluator } from "../evaluator";

describe("v5 evaluator skeleton", () => {
	it("normalizes evaluator routes and next tool recommendations", () => {
		const output = parseEvaluatorOutput(`{
  "success": true,
  "thought": "Need one more lookup.",
  "decision": "NEXT_RECOMMENDED",
  "nextTool": {
    "name": "LOOKUP",
    "args": { "id": 123 }
  }
}`);

		expect(output.decision).toBe("NEXT_RECOMMENDED");
		expect(output.nextTool).toEqual({
			name: "LOOKUP",
			params: { id: 123 },
		});
	});

	it("prefers evaluator-shaped JSON when the model emits stray JSON first", () => {
		const output = parseEvaluatorOutput(`{
  "action": "OPEN_URL",
  "url": "https://example.test"
}{
  "success": false,
  "decision": "CONTINUE",
  "thought": "Need one more grounded tool result."
}`);

		expect(output.success).toBe(false);
		expect(output.decision).toBe("CONTINUE");
		expect(output.thought).toBe("Need one more grounded tool result.");
	});

	it("applies message and clipboard effects through injected callbacks", async () => {
		const copyToClipboard = vi.fn();
		const messageToUser = vi.fn();
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "thought": "Complete.",
  "decision": "FINISH",
  "messageToUser": "Sent.",
  "copyToClipboard": {
    "title": "Artifact",
    "content": "artifact",
    "tags": ["test"]
  }
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: {
						content: "agent_name: Eliza",
						stable: true,
					},
				},
				events: [
					{
						id: "provider:RECENT_MESSAGES",
						type: "provider",
						name: "RECENT_MESSAGES",
						text: "Recent: user asked for status.",
					},
					{
						id: "msg",
						type: "message",
						message: {
							role: "user",
							content: { text: "Check status." },
						},
					},
				],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
			effects: { copyToClipboard, messageToUser },
		});

		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.RESPONSE_HANDLER,
			expect.objectContaining({ messages: expect.any(Array) }),
			undefined,
		);
		const evaluatorParams = runtime.useModel.mock.calls[0][1];
		// Wire-shape contract: evaluator emits ONLY `messages`.
		expect(evaluatorParams.prompt).toBeUndefined();
		expect(evaluatorParams.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(evaluatorParams.messages[0].content).toContain("evaluator_stage:");
		expect(evaluatorParams.messages[0].content).toContain("agent_name: Eliza");
		// Provider events render as `provider:NAME:\n<text>` (label + content);
		// the old shape baked `provider: <name>` into the body, duplicating it.
		expect(evaluatorParams.messages[1].content).toContain(
			"provider:RECENT_MESSAGES:",
		);
		expect(evaluatorParams.messages[1].content).toContain("Check status.");
		expect(evaluatorParams.messages[1].content).not.toMatch(
			/provider:RECENT_MESSAGES:\nprovider: RECENT_MESSAGES/,
		);
		// After the stacking fix, trajectory steps are conveyed as assistant/tool
		// message pairs, NOT as a JSON dump in the user message.
		expect(evaluatorParams.messages[1].content).not.toMatch(/^trajectory:\n\[/);
		expect(
			evaluatorParams.providerOptions.eliza.modelInputBudget,
		).toMatchObject({
			reserveTokens: 10_000,
			shouldCompact: false,
		});
		expect(result.decision).toBe("FINISH");
		expect(copyToClipboard).toHaveBeenCalledWith({
			title: "Artifact",
			content: "artifact",
			tags: ["test"],
		});
		expect(messageToUser).toHaveBeenCalledWith("Sent.");
	});

	it("repairs missing success only when FINISH follows a successful tool result", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "route": "FINISH",
  "thought": "The tool result satisfies the request.",
  "messageToUser": "Done."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: {
						content: "agent_name: Eliza",
						stable: true,
					},
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: {
							id: "tool-1",
							name: "LOOKUP",
							params: { q: "eliza" },
						},
						result: {
							success: true,
							text: "Found results.",
						},
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.decision).toBe("FINISH");
		expect(result.success).toBe(true);
	});
});
