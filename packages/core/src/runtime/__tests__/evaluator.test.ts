import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import { parseEvaluatorOutput, runEvaluator } from "../evaluator";
import { buildEvaluatorGuidance } from "../evaluator-guidance";

describe("v5 evaluator skeleton", () => {
	it("builds evaluator guidance with deterministic success and decision spans", () => {
		const guidance = buildEvaluatorGuidance();
		const successIndex = guidance.responseSkeleton.spans.findIndex(
			(span) => span.key === "success",
		);
		const decisionIndex = guidance.responseSkeleton.spans.findIndex(
			(span) => span.key === "decision",
		);

		expect(guidance.responseSkeleton.id).toBe("evaluator-v1");
		expect(guidance.responseSkeleton.spans[successIndex]).toMatchObject({
			kind: "boolean",
			rule: "jsonbool",
		});
		expect(guidance.responseSkeleton.spans[decisionIndex]).toMatchObject({
			kind: "enum",
			enumValues: ["FINISH", "NEXT_RECOMMENDED", "CONTINUE"],
			rule: "decision",
		});
		expect(guidance.spanSamplerPlan.overrides).toEqual([
			{ spanIndex: successIndex, temperature: 0, topK: 1 },
			{ spanIndex: decisionIndex, temperature: 0, topK: 1 },
		]);
		expect(guidance.grammar).toContain('"FINISH"');
		expect(guidance.grammar).toContain('"NEXT_RECOMMENDED"');
		expect(guidance.grammar).toContain('"CONTINUE"');
		expect(guidance.grammar).toContain('["\\\\/bfnrt]');
	});

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

	it("rejects evaluator text that contains multiple JSON objects", () => {
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
		expect(output.parseError).toBe("response is not a single JSON object");
		expect(output.thought).toContain("Invalid evaluator output");
	});

	it("does not salvage claimed success from malformed evaluator text", () => {
		const output = parseEvaluatorOutput(`{
  "content": "pretend document body"
}{
  "success": true,
  "decision": "FINISH",
  "thought": "Saved the document."
}`);

		expect(output.success).toBe(false);
		expect(output.decision).toBe("CONTINUE");
		expect(output.parseError).toBe("response is not a single JSON object");
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
		expect(evaluatorParams.providerOptions.eliza.guidedDecode).toBe(true);
		expect(evaluatorParams.responseSkeleton?.id).toBe("evaluator-v1");
		expect(evaluatorParams.grammar).toContain("decision ::=");
		expect(evaluatorParams.spanSamplerPlan?.overrides).toEqual([
			{ spanIndex: 1, temperature: 0, topK: 1 },
			{ spanIndex: 3, temperature: 0, topK: 1 },
		]);
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

	it("strips internal task-agent session-ids and auto-generated labels from messageToUser", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Both agents spawned.",
  "messageToUser": "Both agents spawned in parallel (count-py-files-projects-1 and count-ts-files-iqlabs-1). I'll reply with both numbers when they finish."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.messageToUser).not.toContain("count-py-files-projects-1");
		expect(result.messageToUser).not.toContain("count-ts-files-iqlabs-1");
		expect(result.messageToUser).toContain("Both agents spawned in parallel.");
		expect(result.messageToUser).toContain("when they finish");
	});

	it("strips bare PTY session ids and (session: pty-...) parentheticals", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Spawned.",
  "messageToUser": "on it — task agent is running (session: pty-1778500471501-4cf0e3a6). it'll write /tmp/x.py and verify."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.messageToUser).not.toMatch(/pty-\d+-[A-Za-z0-9]+/);
		expect(result.messageToUser).not.toMatch(/\(session/);
		expect(result.messageToUser).toContain("/tmp/x.py");
	});

	it("leaves messageToUser unchanged when no mechanics are mentioned", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Got it.",
  "messageToUser": "190G free on / (387G total, 198G used, 52% used)."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.messageToUser).toBe(
			"190G free on / (387G total, 198G used, 52% used).",
		);
	});

	it("rerolls remote evaluator output that fails the evaluator schema", async () => {
		const runtime = {
			models: new Map([
				[
					ModelType.RESPONSE_HANDLER,
					[
						{
							provider: "anthropic",
							priority: 0,
							registrationOrder: 0,
							handler: vi.fn(),
						},
					],
				],
			]),
			useModel: vi
				.fn()
				.mockResolvedValueOnce(`{
  "success": true,
  "decision": "DONE",
  "thought": "Invalid enum."
}`)
				.mockResolvedValueOnce(`{
  "success": false,
  "decision": "CONTINUE",
  "thought": "Need one more grounded tool result."
}`),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(result.decision).toBe("CONTINUE");
		expect(result.thought).toBe("Need one more grounded tool result.");
	});

	it("does not reroll a guided local evaluator response", async () => {
		const runtime = {
			models: new Map([
				[
					ModelType.RESPONSE_HANDLER,
					[
						{
							provider: "eliza-local-inference",
							priority: 0,
							registrationOrder: 0,
							handler: vi.fn(),
						},
					],
				],
			]),
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "DONE",
  "thought": "Local parser normalization handles this."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(result.decision).toBe("CONTINUE");
	});
});
