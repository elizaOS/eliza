/**
 * Preserved-tool-result rescue when the planner loop dies mid-turn: drives the
 * real `DefaultMessageService.handleMessage` pipeline (real AgentRuntime,
 * in-memory adapter, real planner loop and action execution) with only model
 * transport stubbed. Reproduces the live 2026-08-07/08 incident class — a tool
 * completes, then the post-tool evaluator model call fails — and asserts the
 * completed tool's `userFacingText` reaches the user instead of the canned
 * transient-failure reply, while a turn with genuinely nothing user-facing
 * still gets the canned line. Also unit-covers `preservedSettledToolResult`
 * candidate selection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { PlannerToolResult } from "../runtime/planner-loop";
import type {
	Action,
	ActionResult,
	Content,
	HandlerCallback,
	Memory,
	UUID,
} from "../types";
import { ModelType } from "../types";
import { ChannelType } from "../types/primitives";
import {
	answerlessToolTurnReport,
	DefaultMessageService,
	NO_REPORTABLE_TOOL_OUTCOME_MESSAGE,
	preservedSettledToolResult,
	subAgentCompletionRelayBody,
} from "./message";

const AGENT_ID = "00000000-0000-0000-0000-000000000081" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000082" as UUID;

const USER_FACING = "calendar event saved: eliza-test, tomorrow 3pm.";
const DIAGNOSTIC = "calendar.create op=create id=ev-1 ok exit=0";

// The live evaluator failure shape: a provider/wrapper error with NO HTTP
// status, so the planner-loop's in-loop provider-error relay does not fire and
// the failure propagates to the message service's rescue seam.
const EVALUATOR_FAILURE = new Error(
	"[cli-inference:sdk] subscription rate limit reached: session limit hit",
);

function stageOneToolTurn() {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Look up the entry.",
					contexts: ["general"],
					intents: ["look up entry"],
					candidateActionNames: ["LOOKUP"],
					replyText: "",
					facts: [],
					relationships: [],
					addressedTo: [],
					requiresTool: true,
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function plannerCalendarCall() {
	return {
		thought: "Look up the requested entry.",
		toolCalls: [
			{
				id: "calendar-create-1",
				name: "LOOKUP",
				args: { action: "create" },
			},
		],
	};
}

function makeMessage(runtime: AgentRuntime, text: string): Memory {
	return {
		entityId: USER_ID,
		agentId: runtime.agentId,
		roomId: runtime.agentId,
		content: {
			text,
			source: "client_chat",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	};
}

interface Harness {
	runtime: AgentRuntime;
	callback: HandlerCallback;
	callbacks: Content[];
	sent: Content[];
	reportedScopes: string[];
}

const activeRuntimes: AgentRuntime[] = [];

async function createHarness(options: {
	actionResult: Record<string, unknown>;
}): Promise<Harness> {
	const runtime = new AgentRuntime({
		character: createCharacter({
			id: AGENT_ID,
			name: "Preserved Result Integration",
			bio: "Exercises the planner-loop failure rescue seam.",
			settings: {},
		}),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize({ skipMigrations: true });
	activeRuntimes.push(runtime);

	runtime.actions.length = 0;
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => ({
		values: { availableContexts: "general" },
		data: {},
		text: "Deterministic preserved-tool-result state.",
	})) as AgentRuntime["composeState"];

	const calendarAction: Action = {
		name: "LOOKUP",
		description: "Looks up a stored entry.",
		parameters: [
			{
				name: "action",
				description: "Lookup operation",
				required: true,
				schema: { type: "string", enum: ["create"] },
			},
		],
		validate: async () => true,
		handler: async () => options.actionResult as never,
	};
	runtime.registerAction(calendarAction);

	// Stage 1 succeeds and promotes to planning; every LATER response-handler
	// call (the post-tool evaluator) dies like the live incident. The failure
	// reply generator's TEXT_* calls die the same way, forcing the canned
	// template path when nothing user-facing is preserved.
	let stageOneServed = false;
	runtime.registerModel(
		ModelType.RESPONSE_HANDLER,
		async () => {
			if (!stageOneServed) {
				stageOneServed = true;
				return stageOneToolTurn();
			}
			throw EVALUATOR_FAILURE;
		},
		"preserved-tool-result-test",
		100,
	);
	runtime.registerModel(
		ModelType.ACTION_PLANNER,
		async () => plannerCalendarCall(),
		"preserved-tool-result-test",
		100,
	);
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async () => {
			throw EVALUATOR_FAILURE;
		},
		"preserved-tool-result-test",
		100,
	);

	const reportedScopes: string[] = [];
	const originalReportError = runtime.reportError.bind(runtime);
	runtime.reportError = ((scope, error, context) => {
		reportedScopes.push(String(scope));
		return originalReportError(scope, error, context);
	}) as AgentRuntime["reportError"];

	const callbacks: Content[] = [];
	const sent: Content[] = [];
	runtime.registerSendHandler(
		"client_chat",
		async (_runtime, _target, content) => {
			sent.push(content);
			return undefined;
		},
	);
	const callback: HandlerCallback = async (content: Content) => {
		callbacks.push(content);
		await runtime.sendMessageToTarget(
			{ source: "client_chat", roomId: runtime.agentId },
			content,
		);
		return [];
	};

	return { runtime, callback, callbacks, sent, reportedScopes };
}

function visibleTexts(contents: Content[]): string[] {
	return contents
		.map((content) => (typeof content.text === "string" ? content.text : ""))
		.filter((text) => text.trim().length > 0);
}

describe("planner-loop death after a completed tool", () => {
	beforeEach(() => {
		vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(
			activeRuntimes.splice(0).map(async (runtime) => {
				await runtime.stop();
				await runtime.close();
			}),
		);
	});

	it("delivers the completed tool's user-facing result instead of the canned failure", async () => {
		const harness = await createHarness({
			actionResult: {
				success: true,
				text: DIAGNOSTIC,
				userFacingText: USER_FACING,
				verifiedUserFacing: true,
			},
		});

		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "look up the eliza-test entry"),
			harness.callback,
		);

		expect(result.responseContent?.text).toBe(USER_FACING);
		const delivered = visibleTexts(harness.callbacks);
		expect(delivered).toContain(USER_FACING);
		// The canned transient/rate-limit apology must not replace a result the
		// turn already produced.
		for (const text of delivered) {
			expect(text.toLowerCase()).not.toContain("rate-limit");
			expect(text.toLowerCase()).not.toContain("something went wrong");
			expect(text).not.toContain(DIAGNOSTIC);
		}
		// The loop failure is still reported — the rescue is a degrade, not a
		// success mask.
		expect(harness.reportedScopes).toContain("MessageService.plannerLoop");
	});

	it("keeps the canned failure line when no tool produced user-facing text", async () => {
		const harness = await createHarness({
			actionResult: {
				success: true,
				text: DIAGNOSTIC,
			},
		});

		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, "look up the eliza-test entry"),
			harness.callback,
		);

		const delivered = visibleTexts(harness.callbacks);
		expect(delivered.length).toBeGreaterThan(0);
		// Diagnostic tool text must never render as assistant prose, so the
		// canned failure template (rate-limited here, since every model call in
		// this turn is rate-limited) is the correct degrade.
		expect(delivered.join("\n").toLowerCase()).toContain("rate-limit");
		expect(delivered.join("\n")).not.toContain(DIAGNOSTIC);
		expect(result.responseContent?.text ?? "").not.toContain(DIAGNOSTIC);
	});
});

describe("subAgentCompletionRelayBody parsing (#18208)", () => {
	const RELAY_HEADER =
		"[sub-agent: review pr 18175 (elizaos) — task_complete — this delegated task is DONE; the result is below, relay it to the user as the answer and do NOT start another sub-agent for it.]";
	const RESULT_BODY =
		"The PR fixes the pairing dead-end: hosts now redeem the in-progress pairing instead of dropping it. Two files changed, tests included.";

	it("extracts the result body from a task_complete relay", () => {
		expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n${RESULT_BODY}`)).toBe(
			RESULT_BODY,
		);
	});

	it("parses task_complete from a canonical header beyond character 400", () => {
		const longHeader = `[sub-agent: ${"review context ".repeat(35)} (elizaos) — task_complete — this delegated task is DONE; relay the result.]`;
		expect(longHeader.indexOf("task_complete")).toBeGreaterThan(400);
		expect(subAgentCompletionRelayBody(`${longHeader}\n${RESULT_BODY}`)).toBe(
			RESULT_BODY,
		);
	});

	it("returns undefined for non-relay text, non-complete events, and empty bodies", () => {
		expect(subAgentCompletionRelayBody("what's the weather")).toBeUndefined();
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: devops (elizaos) — error]\nsub-agent reported an error",
			),
		).toBeUndefined();
		expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n   `)).toBeUndefined();
		expect(subAgentCompletionRelayBody(undefined)).toBeUndefined();
	});

	it("does not infer completion from task labels or result bodies", () => {
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: explain task_complete handling (elizaos) — blocked]\nNeed approval.",
			),
		).toBeUndefined();
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: status check (elizaos) — error]\nThe body says task_complete but the task failed.",
			),
		).toBeUndefined();
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: explain task_complete handling]\nNo structured status.",
			),
		).toBeUndefined();
		expect(
			subAgentCompletionRelayBody(
				"[sub-agent: quote — task_complete — this delegated task is DONE; in docs (elizaos) — blocked]\nNeed approval.",
			),
		).toBeUndefined();
		for (const event of ["QUESTION_FOR_TASK_CREATOR", "AGENT_COORDINATION"]) {
			expect(
				subAgentCompletionRelayBody(
					`[sub-agent: explain task_complete (${event}) — ${event}]\nNeed input.`,
				),
			).toBeUndefined();
		}
	});

	it("preserves a long completed result body", () => {
		const huge = "x".repeat(5000);
		expect(subAgentCompletionRelayBody(`${RELAY_HEADER}\n${huge}`)).toBe(huge);
	});

	it("a failed relay turn delivers the completed result instead of the canned line", async () => {
		// Same failing-turn harness as above (tool result carries nothing
		// user-facing, every later model call dies) — but the TRIGGERING message
		// is a task_complete relay, so the finished result it carries must win
		// over any canned failure text.
		const harness = await createHarness({
			actionResult: { success: false, text: DIAGNOSTIC },
		});

		const result = await new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(harness.runtime, `${RELAY_HEADER}\n${RESULT_BODY}`),
			harness.callback,
		);

		const delivered = visibleTexts(harness.callbacks);
		const everything = [
			...delivered,
			String(result.responseContent?.text ?? ""),
		].join("\n");
		// The completed result reaches the user…
		expect(everything).toContain("pairing dead-end");
		// …and no canned failure/apology text replaces it.
		expect(everything.toLowerCase()).not.toContain("runtime step failed");
		expect(everything).not.toContain(DIAGNOSTIC);
	});
});

describe("preservedSettledToolResult candidate selection", () => {
	const settle = (
		name: string,
		result: Partial<PlannerToolResult>,
	): { name: string; result: PlannerToolResult } => ({
		name,
		result: { success: true, ...result } as PlannerToolResult,
	});

	it("picks the most recent successful non-terminal result with user-facing text", () => {
		const picked = preservedSettledToolResult(
			[
				settle("MEMORY_SEARCH", { userFacingText: "older answer" }),
				settle("LOOKUP", { userFacingText: USER_FACING }),
			],
			new Set(),
		);
		expect(picked?.userFacingText).toBe(USER_FACING);
	});

	it("skips failed results, terminals, and results without user-facing text", () => {
		expect(
			preservedSettledToolResult(
				[
					settle("LOOKUP", { success: false, userFacingText: "failed op" }),
					settle("REPLY", { userFacingText: "terminal reply text" }),
					settle("MEMORY_CREATE", { text: "Stored memory ev-1." }),
					settle("MEMORY_CREATE", { userFacingText: "   " }),
				],
				new Set(),
			),
		).toBeUndefined();
	});

	it("skips a result the user already saw and falls back to an earlier one", () => {
		const deliveredNormalized = USER_FACING.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
		const picked = preservedSettledToolResult(
			[
				settle("MEMORY_SEARCH", { userFacingText: "undelivered answer" }),
				settle("LOOKUP", { userFacingText: USER_FACING }),
			],
			new Set([deliveredNormalized]),
		);
		expect(picked?.userFacingText).toBe("undelivered answer");
	});

	it("returns undefined when everything eligible was already delivered", () => {
		const deliveredNormalized = USER_FACING.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
		expect(
			preservedSettledToolResult(
				[settle("LOOKUP", { userFacingText: USER_FACING })],
				new Set([deliveredNormalized]),
			),
		).toBeUndefined();
	});
});

describe("answerlessToolTurnReport", () => {
	const asyncAction: Action = {
		name: "TASKS",
		similes: ["TASKS_SPAWN_AGENT"],
		description: "Spawn a task.",
		asyncHandoff: true,
		validate: async () => true,
		handler: async () => ({ success: true }),
	};
	const settled = (
		result: Partial<PlannerToolResult>,
	): Array<{ name: string; result: PlannerToolResult }> => [
		{
			name: "TASKS_SPAWN_AGENT",
			result: { success: true, ...result } as PlannerToolResult,
		},
	];
	const report = (
		result: Partial<PlannerToolResult>,
		actionResult: ActionResult,
	): string =>
		answerlessToolTurnReport({
			settledToolResults: settled(result),
			deliveredVisibleTexts: new Set(),
			actionResults: [actionResult],
			actions: [asyncAction],
			stageOneAck: "On it.",
		});

	it("never retains an ack for a failed async handoff", () => {
		expect(
			report(
				{ success: false, text: "spawn failed" },
				{ success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
			),
		).toBe(NO_REPORTABLE_TOOL_OUTCOME_MESSAGE);
	});

	it("retains an ack only after applied acceptance proof", () => {
		expect(
			report(
				{ success: true },
				{
					success: true,
					data: { actionName: "TASKS_SPAWN_AGENT" },
					effectReceipts: [
						{
							receiptId: "spawn-1",
							operation: "tasks.spawn_agent",
							outcome: "applied",
							resource: { kind: "acp.session", id: "session-1" },
							artifacts: [],
							idempotency: { key: null, replayed: false },
							observedAt: "2026-08-15T00:00:00.000Z",
							commit: {
								kind: "provider_accepted",
								id: "session-1",
								committedAt: "2026-08-15T00:00:00.000Z",
							},
						},
					],
				},
			),
		).toBe("On it.");
	});

	it("preserves a verified failed outcome instead of a generic line", () => {
		const failure = "The coding task could not authenticate.";
		expect(
			report(
				{
					success: false,
					userFacingText: failure,
					verifiedUserFacing: true,
				},
				{ success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
			),
		).toBe(failure);
	});

	it("does not trust an unverified failure projection", () => {
		expect(
			report(
				{ success: false, userFacingText: "raw provider failure" },
				{ success: false, data: { actionName: "TASKS_SPAWN_AGENT" } },
			),
		).toBe(NO_REPORTABLE_TOOL_OUTCOME_MESSAGE);
	});
});
