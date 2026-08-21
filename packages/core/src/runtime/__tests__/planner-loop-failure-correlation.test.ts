/**
 * Guards failed-operation authority when later calls use the same tool for a
 * different entity or argument set. Deterministic planner and evaluator mocks
 * exercise both terminal replies and evaluator-protocol recovery.
 */

import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

const failureA = "Note A could not be updated.";
const successB = "Note B was updated.";

function plannerToolCall(
	id: string,
	name: string,
	args: Record<string, unknown>,
) {
	return {
		text: "",
		toolCalls: [
			{
				id: `call-${id}`,
				name,
				arguments: args,
			},
		],
	};
}

function viewsUpdateCall(id: string, title: string) {
	return plannerToolCall(id, "VIEWS", {
		action: "interact",
		view: "notes",
		capability: "update-note",
		params: { id, title },
	});
}

function runtimeForFailureThenSuccessThenReply() {
	return {
		useModel: vi
			.fn()
			.mockResolvedValueOnce(viewsUpdateCall("note-a", "A"))
			.mockResolvedValueOnce(viewsUpdateCall("note-b", "B"))
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "reply",
						name: "REPLY",
						arguments: { text: "Both notes were updated." },
					},
				],
			}),
	};
}

function executeFailureAThenSuccessB() {
	return vi
		.fn()
		.mockResolvedValueOnce({
			success: false,
			error: "note-a-conflict",
			text: failureA,
			userFacingText: failureA,
		})
		.mockResolvedValueOnce({
			success: true,
			text: successB,
			userFacingText: successB,
		});
}

async function withCodingFullSurface<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
	process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "1";
	try {
		return await run();
	} finally {
		if (previous === undefined) {
			delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
		} else {
			process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = previous;
		}
	}
}

describe("planner-loop failed-operation correlation", () => {
	it("finishes with the just-failed action when its evaluator violates protocol", async () => {
		const runtime = {
			useModel: vi.fn().mockResolvedValueOnce(
				plannerToolCall("home", "VIEWS", {
					action: "show",
					view: "home",
				}),
			),
		};
		const failure = 'No view matches "home".';
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi.fn().mockResolvedValueOnce({
				success: false,
				text: failure,
				userFacingText: failure,
			}),
			evaluate: vi.fn().mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE",
				thought: "Invalid evaluator envelope.",
				protocolFailure: true,
			}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(failure);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("clears a failure only for the same operation despite argument key order", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(viewsUpdateCall("note-a", "A"))
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-note-a-retry",
							name: "VIEWS",
							arguments: {
								params: { title: "A", id: "note-a" },
								capability: "update-note",
								view: "notes",
								action: "interact",
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: "The note was updated." },
						},
					],
				}),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "note-a-conflict",
					text: failureA,
					userFacingText: failureA,
				})
				.mockResolvedValueOnce({
					success: true,
					text: "Retry succeeded.",
					userFacingText: "Retry succeeded.",
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Retry the same mutation.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Return the successful outcome.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("The note was updated.");
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("clears a schema rejection when the retry removes only the rejected argument", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(
					plannerToolCall("search-invalid-room", "MEMORY_SEARCH", {
						action: "search",
						query: "bitcoin",
						type: "messages",
						roomId: "current",
					}),
				)
				.mockResolvedValueOnce(
					plannerToolCall("search-corrected", "MEMORY_SEARCH", {
						action: "search",
						query: "bitcoin",
						type: "messages",
					}),
				),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "roomId did not match the UUID schema",
					data: {
						parameterErrors: ["roomId did not match the UUID schema"],
						invalidParameterNames: ["roomId"],
					},
				})
				.mockResolvedValueOnce({
					success: true,
					text: "Found four matching messages.",
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Retry without the rejected room filter.",
				})
				.mockResolvedValueOnce({
					success: true,
					decision: "FINISH",
					thought: "The corrected search completed.",
					messageToUser: "You mentioned bitcoin three times.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("You mentioned bitcoin three times.");
	});

	it("clears a failure when the retry differs only in free-text description narration (live incident: builders re-narrate retried commands, and the stale failure authority replaced their terminal completion proof)", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "verify-1",
							name: "SHELL",
							arguments: {
								action: "run",
								command: "bun run typecheck && bun run lint && bun run test",
								description: "Run the verification commands",
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "verify-2",
							name: "SHELL",
							arguments: {
								action: "run",
								command: "bun run typecheck && bun run lint && bun run test",
								description: "Re-run verification after formatting fixes",
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: 'APP_CREATE_DONE {"appName":"demo"}' },
						},
					],
				}),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "lint failed",
					text: "biome check failed on generated code",
				})
				.mockResolvedValueOnce({
					success: true,
					text: "all checks pass",
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Fix formatting and re-run.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Emit the completion proof.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toContain("APP_CREATE_DONE");
	});

	it("keeps description operative for tools whose description is the mutation payload", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(
					plannerToolCall("task-a", "TASKS_CREATE", {
						description: "Repair project A",
					}),
				)
				.mockResolvedValueOnce(
					plannerToolCall("task-b", "TASKS_CREATE", {
						description: "Repair project B",
					}),
				)
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: "Both repair tasks were created." },
						},
					],
				}),
		};
		const taskFailure = "Project A task creation failed.";
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "task-a-failure",
					text: taskFailure,
					userFacingText: taskFailure,
				})
				.mockResolvedValueOnce({
					success: true,
					text: "Project B task created.",
					userFacingText: "Project B task created.",
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Create the other task.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Invalid evaluator envelope.",
					protocolFailure: true,
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(taskFailure);
		expect(result.finalMessage).not.toContain("Both repair tasks");
	});

	it("keeps a failed SHELL command authoritative when an unrelated command succeeds before REPLY", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(
					plannerToolCall("shell-a", "SHELL", {
						command: "pnpm test",
						cwd: "/workspace/project-a",
					}),
				)
				.mockResolvedValueOnce(
					plannerToolCall("shell-b", "SHELL", {
						command: "pnpm test",
						cwd: "/workspace/project-b",
					}),
				)
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: "Both test runs passed." },
						},
					],
				}),
		};
		const shellFailure = "Project A tests failed.";
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "project-a-failure",
					text: shellFailure,
					userFacingText: shellFailure,
				})
				.mockResolvedValueOnce({
					success: true,
					text: "Project B tests passed.",
					userFacingText: "Project B tests passed.",
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Continue with the second project.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Invalid evaluator envelope.",
					protocolFailure: true,
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(shellFailure);
		expect(result.finalMessage).not.toContain("Both test runs passed");
		expect(result.finalMessage).not.toContain("Project B tests passed");
	});

	it("keeps a failed VIEWS operation authoritative over an unrelated evaluator FINISH", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(viewsUpdateCall("note-a", "A"))
				.mockResolvedValueOnce(viewsUpdateCall("note-b", "B")),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: executeFailureAThenSuccessB(),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Continue with the other note.",
				})
				.mockResolvedValueOnce({
					success: true,
					decision: "FINISH",
					thought: "Both mutations are complete.",
					messageToUser: "Both notes were updated.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(failureA);
		expect(result.finalMessage).not.toContain("Both notes were updated");
	});

	it("keeps a later confirmation actionable when continueChain ends after an earlier failure", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(viewsUpdateCall("note-a", "A"))
				.mockResolvedValueOnce(
					plannerToolCall("send-b", "SEND", {
						to: "owner@example.com",
						text: "Project B update",
					}),
				),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "note-a-conflict",
					text: failureA,
					userFacingText: failureA,
				})
				.mockResolvedValueOnce({
					success: true,
					continueChain: false,
					text: "Confirm B.",
					userFacingText: "Confirm B.",
					data: { requiresConfirmation: true },
				}),
			evaluate: vi.fn().mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE",
				thought: "The unrelated note update failed.",
			}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Confirm B.");
	});

	it("keeps a later confirmation actionable over evaluator FINISH prose", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(viewsUpdateCall("note-a", "A"))
				.mockResolvedValueOnce(
					plannerToolCall("send-b", "SEND", {
						to: "owner@example.com",
						text: "Project B update",
					}),
				),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "note-a-conflict",
					text: failureA,
					userFacingText: failureA,
				})
				.mockResolvedValueOnce({
					success: true,
					text: "Confirm B.",
					userFacingText: "Confirm B.",
					data: { requiresConfirmation: true },
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "The unrelated note update failed.",
				})
				.mockResolvedValueOnce({
					success: true,
					decision: "FINISH",
					thought: "The send needs approval.",
					messageToUser: "Project B was sent.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Confirm B.");
		expect(result.finalMessage).not.toContain("was sent");
	});

	it("keeps a later confirmation actionable over native terminal REPLY prose", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(viewsUpdateCall("note-a", "A"))
				.mockResolvedValueOnce(
					plannerToolCall("send-b", "SEND", {
						to: "owner@example.com",
						text: "Project B update",
					}),
				)
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: "Project B was sent." },
						},
					],
				}),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "note-a-conflict",
					text: failureA,
					userFacingText: failureA,
				})
				.mockResolvedValueOnce({
					success: true,
					text: "Confirm B.",
					userFacingText: "Confirm B.",
					data: { requiresConfirmation: true },
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "The unrelated note update failed.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "The send needs approval.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Confirm B.");
		expect(result.finalMessage).not.toContain("was sent");
	});

	it("does not let an older confirmation hide a newer failed operation", async () => {
		const newestFailure = "Project C tests failed.";
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(viewsUpdateCall("note-a", "A"))
				.mockResolvedValueOnce(
					plannerToolCall("send-b", "SEND", {
						to: "owner@example.com",
						text: "Project B update",
					}),
				)
				.mockResolvedValueOnce(
					plannerToolCall("shell-c", "SHELL", {
						command: "pnpm test",
						cwd: "/workspace/project-c",
					}),
				),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: true,
					text: "Note A was updated.",
					userFacingText: "Note A was updated.",
				})
				.mockResolvedValueOnce({
					success: true,
					text: "Confirm B.",
					userFacingText: "Confirm B.",
					data: { requiresConfirmation: true },
				})
				.mockResolvedValueOnce({
					success: false,
					error: "project-c-failure",
					text: newestFailure,
					userFacingText: newestFailure,
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Ask for confirmation.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Run the final project test.",
				})
				.mockResolvedValueOnce({
					success: true,
					decision: "FINISH",
					thought: "All operations are complete.",
					messageToUser: "Everything completed.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(newestFailure);
		expect(result.finalMessage).not.toContain("Confirm B.");
	});

	it("keeps a failed SHELL operation authoritative over coding terminal prose", async () => {
		await withCodingFullSurface(async () => {
			const runtime = {
				useModel: vi
					.fn()
					.mockResolvedValueOnce({
						text: "",
						toolCalls: [
							{
								id: "shell-a",
								name: "SHELL",
								arguments: {
									command: "pnpm test",
									cwd: "/workspace/project-a",
								},
							},
							{
								id: "shell-b",
								name: "SHELL",
								arguments: {
									command: "pnpm test",
									cwd: "/workspace/project-b",
								},
							},
						],
					})
					.mockResolvedValueOnce({ text: "Both test runs passed." }),
			};
			const shellFailure = "Project A tests failed.";
			const evaluate = vi.fn();
			const result = await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				executeToolCall: vi
					.fn()
					.mockResolvedValueOnce({
						success: false,
						error: "project-a-failure",
						text: shellFailure,
						userFacingText: shellFailure,
					})
					.mockResolvedValueOnce({
						success: true,
						text: "Project B tests passed.",
						userFacingText: "Project B tests passed.",
					}),
				evaluate,
			});

			expect(result.status).toBe("finished");
			// The failure keeps the lead and the model's contradicting prose is
			// excluded, but the tool-owned success from project B is reported —
			// erasing it produced the inverse lie ("never produced a usable
			// result" while the deliverable shipped, live 2026-08-16).
			expect(result.finalMessage?.startsWith(shellFailure)).toBe(true);
			expect(result.finalMessage).not.toContain("Both test runs passed");
			expect(result.finalMessage).toContain("Project B tests passed.");
			expect(evaluate).not.toHaveBeenCalled();
		});
	});

	it("reports tool-owned recovery evidence after an unresolved coding failure", async () => {
		await withCodingFullSurface(async () => {
			const runtime = {
				useModel: vi
					.fn()
					.mockResolvedValueOnce({
						text: "",
						toolCalls: [
							{
								id: "shell-echo",
								name: "SHELL",
								arguments: { command: "echo $PATH", cwd: "/workspace" },
							},
						],
					})
					.mockResolvedValueOnce({
						text: "",
						toolCalls: [
							{
								id: "file-write",
								name: "FILE",
								arguments: {
									action: "write",
									file_path: "index.html",
								},
							},
						],
					})
					.mockResolvedValueOnce({
						text: "Done! The page is live.",
					}),
			};
			const shellFailure = "No boot-authorized shell was detected.";
			const evaluate = vi.fn();
			const result = await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				executeToolCall: vi
					.fn()
					.mockResolvedValueOnce({
						success: false,
						error: "command_failed",
						text: shellFailure,
						userFacingText: shellFailure,
					})
					.mockResolvedValueOnce({
						success: true,
						text: "Wrote index.html (74 lines).",
						userFacingText: "Wrote index.html (74 lines).",
					}),
				evaluate,
			});

			expect(result.status).toBe("finished");
			// The live 2026-08-16 inversion: the sub-agent built and deployed its
			// page after auxiliary shell failures, and the final message claimed
			// nothing usable was produced. The failure keeps the lead; the
			// tool-owned write is reported as recovery evidence; untrusted model
			// prose stays out.
			expect(result.finalMessage?.startsWith(shellFailure)).toBe(true);
			expect(result.finalMessage).toContain("Wrote index.html (74 lines).");
			expect(result.finalMessage).not.toContain("Done! The page is live.");
			expect(result.finalMessage).not.toBe(shellFailure);
		});
	});

	it("preserves a structured app proof for independent verification after an unrelated coding probe fails", async () => {
		await withCodingFullSurface(async () => {
			const proof =
				'APP_CREATE_DONE {"appName":"garden","files":["src/index.tsx"],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"ok"}';
			const runtime = {
				useModel: vi
					.fn()
					.mockResolvedValueOnce(
						plannerToolCall("bad-glob", "FILE", {
							action: "glob",
							path: "/workspace",
						}),
					)
					.mockResolvedValueOnce(
						plannerToolCall("verify", "SHELL", {
							action: "run",
							command: "bun run test",
							cwd: "/workspace",
						}),
					)
					.mockResolvedValueOnce({
						text: "",
						toolCalls: [
							{ id: "reply", name: "REPLY", arguments: { text: proof } },
						],
					}),
			};
			const result = await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				executeToolCall: vi
					.fn()
					.mockResolvedValueOnce({
						success: false,
						error: "pattern is required",
						text: "The file search could not run.",
						userFacingText: "The file search could not run.",
					})
					.mockResolvedValueOnce({
						success: true,
						text: "1 test passed.",
						userFacingText: "1 test passed.",
					}),
				evaluate: vi
					.fn()
					.mockResolvedValueOnce({
						success: false,
						decision: "CONTINUE",
						thought: "Use a direct verification command.",
					})
					.mockResolvedValueOnce({
						success: false,
						decision: "CONTINUE",
						thought: "Submit the proof.",
					}),
			});

			expect(result.status).toBe("finished");
			expect(result.finalMessage).toBe(proof);
		});
	});

	it("keeps failed entity A authoritative when a terminal REPLY follows successful entity B", async () => {
		const runtime = runtimeForFailureThenSuccessThenReply();
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: executeFailureAThenSuccessB(),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Retry another requested mutation.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Return a grounded summary.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(failureA);
		expect(result.finalMessage).not.toContain("Both notes were updated");
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("keeps the unresolved failure receipt authoritative over a fenced action-envelope reply", async () => {
		const leakedEnvelope =
			'```json\n{"action":"VIEWS","parameters":{"action":"interact","view":"notes","capability":"update-note","params":{"id":"note-a","title":"A"}}}\n```';
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(viewsUpdateCall("note-a", "A"))
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: leakedEnvelope },
						},
					],
				}),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi.fn().mockResolvedValueOnce({
				success: false,
				error: "note-a-conflict",
				text: failureA,
				userFacingText: failureA,
				data: { receiptId: "receipt-note-a-failure" },
			}),
			evaluate: vi.fn().mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE",
				thought: "The mutation failed.",
			}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(failureA);
		expect(result.finalMessage).not.toContain('"action":"VIEWS"');
	});

	it("does not relay successful B when evaluator protocol fails after failed A", async () => {
		const runtime = runtimeForFailureThenSuccessThenReply();
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: executeFailureAThenSuccessB(),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Continue after the first failure.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Invalid evaluator envelope.",
					protocolFailure: true,
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(failureA);
		expect(result.finalMessage).not.toBe(successB);
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});
});
