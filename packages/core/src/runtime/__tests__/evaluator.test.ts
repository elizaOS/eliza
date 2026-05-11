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

	it("downgrades FINISH to CONTINUE when messageToUser promises unexecuted work after a failed tool", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": false,
  "decision": "FINISH",
  "thought": "SHELL returned empty. I need to spawn a task agent. Let me inform the channel.",
  "messageToUser": "On it — kicking off a build task now. Will install Android SDK if needed and report back."
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
				steps: [
					{
						toolCall: { id: "t1", name: "SHELL", params: { command: "ls" } },
						result: { success: false, text: "" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
		expect(result.success).toBe(false);
	});

	it("leaves FINISH alone when messageToUser is grounded in a successful tool result", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Build succeeded.",
  "messageToUser": "On it — wait, actually it's done. APK at /tmp/out.apk."
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
				steps: [
					{
						toolCall: { id: "t1", name: "BUILD", params: {} },
						result: { success: true, text: "Built." },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		// Grounded FINISH: even forward-looking words pass through because the
		// most recent tool result was successful (the work was actually done).
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("APK at /tmp/out.apk");
	});

	it("leaves non-promise messageToUser alone after a failed tool", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": false,
  "decision": "FINISH",
  "thought": "Tool failed; user needs to retry.",
  "messageToUser": "The command failed with exit 2. Try again with the right path."
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
				steps: [
					{
						toolCall: { id: "t1", name: "SHELL", params: { command: "ls" } },
						result: { success: false, text: "exit 2" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		// Diagnostic messageToUser (no future-tense promise) stays as FINISH so
		// the user gets the explanation instead of an empty replan.
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("exit 2");
	});

	it("downgrades FINISH to CONTINUE when messageToUser promises 'Writing `/path` now...' but no tool wrote to that path", async () => {
		// Live failure: bot ran READ + BASH + ATTACHMENT + multi-tool probing,
		// landed on a correct diagnosis, then closed with
		// 'Writing `/tmp/arxiv-grab-fixed.py` now...'. The latest tool (a
		// debug BASH) succeeded, so the simple "last-tool-failed" guard
		// missed it. The fix checks whether the promised path was actually
		// written by any successful tool in the trajectory.
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Found bug. Should write fix.",
  "messageToUser": "Found the bug — regex uses double quotes but HTML uses single. Writing \`/tmp/arxiv-grab-fixed.py\` now..."
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
				steps: [
					{
						toolCall: {
							id: "t1",
							name: "READ",
							params: { file_path: "/tmp/arxiv-grab.py" },
						},
						result: { success: true, text: "...source..." },
					},
					{
						toolCall: {
							id: "t2",
							name: "WRITE",
							params: {
								// Wrote to a DIFFERENT path (debug), not the promised path.
								file_path: "/tmp/arxiv-debug.py",
								content: "...",
							},
						},
						result: { success: true, text: "wrote 1373 bytes" },
					},
					{
						// Latest tool succeeds — original repair would have left FINISH alone.
						toolCall: {
							id: "t3",
							name: "BASH",
							params: { command: "curl -s arxiv.org | head" },
						},
						result: { success: true, text: "exit 0" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
		expect(result.success).toBe(false);
	});

	it("leaves FINISH alone when the promised 'Writing `/path` now' file WAS written by a tool", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Wrote the fix.",
  "messageToUser": "Writing \`/tmp/arxiv-grab-fixed.py\` now... done. 38 lines, syntax checks pass."
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
				steps: [
					{
						toolCall: {
							id: "t1",
							name: "WRITE",
							params: {
								file_path: "/tmp/arxiv-grab-fixed.py",
								content: "...fix...",
							},
						},
						result: { success: true, text: "wrote 1200 bytes" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		// Promise is grounded — the file WAS written, so FINISH stands.
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("done.");
	});

	it("accepts a BASH-style write (cat > /path / tee /path / > /path) as fulfilling the path promise", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Wrote it via tee.",
  "messageToUser": "Writing \`/tmp/script.sh\` now. Done."
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
				steps: [
					{
						toolCall: {
							id: "t1",
							name: "BASH",
							params: { command: "echo 'hi' | tee /tmp/script.sh" },
						},
						result: { success: true, text: "hi" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		// The BASH command mentions /tmp/script.sh and succeeded, so the
		// promise is considered fulfilled.
		expect(result.decision).toBe("FINISH");
	});
});
