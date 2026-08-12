/**
 * Receipt-backed planner read observations are projected through the real
 * planner/evaluator boundary without becoming generic tool text or user prose.
 */
import { describe, expect, it, vi } from "vitest";
import type { EffectReceipt } from "../../types/effects";
import { runEvaluator } from "../evaluator";
import {
	actionResultToPlannerToolResult,
	runPlannerLoop,
	TOOL_RESULT_UNAVAILABLE_MESSAGE,
} from "../planner-loop";
import {
	projectEvaluatorVisibleTrajectory,
	projectModelVisibleTrajectory,
} from "../planner-trajectory";
import type { PlannerToolResult, PlannerTrajectory } from "../planner-types";

const observedAt = "2026-08-12T12:00:00.000Z";

function noopReceipt(replayed = false): EffectReceipt {
	return {
		receiptId: "read-receipt",
		operation: "agent-orchestrator.tasks.history",
		resource: { kind: "orchestrator.read", id: "history" },
		artifacts: [],
		idempotency: { key: replayed ? "history" : null, replayed },
		observedAt,
		outcome: "noop",
		reason: "The operation only read orchestrator state.",
	};
}

function appliedReceipt(): EffectReceipt {
	return {
		receiptId: "applied-receipt",
		operation: "agent-orchestrator.tasks.send",
		resource: { kind: "acp.session", id: "session" },
		artifacts: [],
		idempotency: { key: "send", replayed: false },
		observedAt,
		outcome: "applied",
		commit: {
			kind: "provider_accepted",
			id: "commit",
			committedAt: observedAt,
		},
	};
}

function unknownReceipt(): EffectReceipt {
	return {
		receiptId: "unknown-receipt",
		operation: "agent-orchestrator.tasks.send",
		resource: { kind: "acp.session", id: "session" },
		artifacts: [],
		idempotency: { key: "send", replayed: false },
		observedAt,
		outcome: "failed",
		failure: {
			code: "ACCEPTANCE_UNKNOWN",
			retryable: false,
			acceptance: "unknown",
		},
	};
}

function trajectory(
	result: PlannerToolResult,
	archived = false,
): PlannerTrajectory {
	const step = {
		iteration: 1,
		toolCall: { name: "TASKS", params: { action: "history" } },
		result,
	};
	return {
		context: { id: "ctx", events: [] },
		steps: archived ? [] : [step],
		archivedSteps: archived ? [step] : [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};
}

function modelAuthority(result: PlannerToolResult, archived = false): string {
	const projected = projectModelVisibleTrajectory(trajectory(result, archived));
	const event = projected.context.events.find(
		(candidate) => candidate.id === "model-visible-tool-authority",
	);
	if (event?.type !== "segment") return "";
	return event.segment.content;
}

function readResult(observation: string): PlannerToolResult {
	return {
		success: true,
		plannerObservation: observation,
		userFacingEffect: "none",
		effectReceipts: [noopReceipt()],
	};
}

describe("planner read observation authority", () => {
	it("survives the canonical ActionResult mapper", () => {
		const mapped = actionResultToPlannerToolResult({
			success: true,
			plannerObservation: "three active agents",
			userFacingEffect: "none",
			effectReceipts: [noopReceipt()],
		});

		expect(mapped.plannerObservation).toBe("three active agents");
		expect(mapped.text).toBeUndefined();
	});

	it("projects one bounded scrubbed observation for live and archived steps", () => {
		const secret = "bearer-never-show";
		const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
		const awsKey = "AKIAIOSFODNN7EXAMPLE";
		const raw = [
			"Read result:",
			"/private/runtime/task.ts",
			"C:\\Users\\owner\\secret.txt",
			uuid,
			`Authorization: Bearer ${secret}`,
			"API_TOKEN=token-never-show",
			awsKey,
			"x".repeat(5000),
			"🧪",
		].join(" ");
		const result = readResult(raw);
		const live = modelAuthority(result);
		const archived = modelAuthority(result, true);

		expect(live).toBe(archived);
		expect(live).toContain("planner_observation:");
		expect(live).toContain("Read result:");
		expect(live).toContain("[path omitted]");
		expect(live).toContain("[identifier omitted]");
		expect(live).toContain("[credential omitted]");
		for (const forbidden of [
			"/private/runtime",
			"C:\\Users",
			uuid,
			secret,
			"token-never-show",
			awsKey,
		]) {
			expect(live).not.toContain(forbidden);
		}
		const line = live
			.split("\n")
			.find((candidate) => candidate.startsWith("planner_observation: "));
		expect(line).toBeDefined();
		const observation = JSON.parse(
			line?.slice("planner_observation: ".length) ?? '""',
		) as string;
		expect(observation.length).toBeLessThanOrEqual(4000);
		expect(observation).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
		expect(observation).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
	});

	it.each([
		[
			"failure",
			{
				...readResult("must stay hidden"),
				success: false,
				error: "READ_FAILED",
			},
		],
		[
			"missing receipt",
			{
				success: true,
				plannerObservation: "must stay hidden",
				userFacingEffect: "none" as const,
			},
		],
		[
			"replayed no-op",
			{
				success: true,
				plannerObservation: "must stay hidden",
				userFacingEffect: "none" as const,
				effectReceipts: [noopReceipt(true)],
			},
		],
		[
			"applied mutation spoof",
			{
				success: true,
				plannerObservation: "must stay hidden",
				effectReceipts: [appliedReceipt()],
			},
		],
		[
			"unknown outcome",
			{
				success: true,
				plannerObservation: "must stay hidden",
				userFacingEffect: "none" as const,
				effectReceipts: [unknownReceipt()],
			},
		],
		[
			"applied receipt mislabeled no-effect",
			{
				success: true,
				plannerObservation: "must stay hidden",
				userFacingEffect: "none" as const,
				effectReceipts: [appliedReceipt()],
			},
		],
	])("omits %s observations", (_name, result) => {
		expect(modelAuthority(result)).not.toContain("planner_observation:");
		expect(
			JSON.stringify(projectEvaluatorVisibleTrajectory(trajectory(result))),
		).not.toContain("plannerObservation");
	});

	it("omits a read observation revoked by a later rollback", () => {
		const read = noopReceipt();
		const rollback: EffectReceipt = {
			receiptId: "rollback-receipt",
			operation: "agent-orchestrator.tasks.rollback",
			resource: read.resource,
			artifacts: [],
			idempotency: { key: "rollback", replayed: false },
			observedAt,
			outcome: "rolled_back",
			rollback: {
				receiptId: "rollback-commit",
				revertedReceiptIds: [read.receiptId],
				rolledBackAt: observedAt,
			},
		};
		const result = {
			...readResult("must stay hidden"),
			effectReceipts: [read, rollback],
		};

		expect(modelAuthority(result)).not.toContain("planner_observation:");
	});

	it("gives custom evaluators the same sanitized observation without receipts", () => {
		const evaluator = projectEvaluatorVisibleTrajectory(
			trajectory(readResult("Result at /private/runtime/task.ts")),
		);
		const projectedResult = evaluator.steps[0]?.result;

		expect(projectedResult?.plannerObservation).toBe(
			"Result at [path omitted]",
		);
		expect(projectedResult?.effectReceipts).toBeUndefined();
		expect(projectedResult?.text).toBeUndefined();
		expect(projectedResult?.data).toBeUndefined();
	});

	it("renders the receipt-bearing source through the default evaluator model call", async () => {
		const source = trajectory(
			readResult(
				"Three active agents at /private/runtime with Authorization: Bearer never-show-value",
			),
		);
		const evaluatorTrajectory = projectEvaluatorVisibleTrajectory(source);
		const useModel = vi.fn(async () =>
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "The read completed.",
				messageToUser: "Three agents are active.",
			}),
		);

		await runEvaluator({
			runtime: { useModel },
			context: evaluatorTrajectory.context,
			trajectory: evaluatorTrajectory,
			modelInputTrajectory: source,
		});

		const input = JSON.stringify(useModel.mock.calls[0]?.[1]);
		expect(input).toContain("planner_observation");
		expect(input).toContain("Three active agents");
		expect(input).toContain("[path omitted]");
		expect(input).not.toContain("/private/runtime");
		expect(input).not.toContain("never-show-value");
		expect(input).not.toContain("read-receipt");
	});

	it("never restores generic diagnostic text or data", () => {
		const result = {
			...readResult("approved read result"),
			text: "RAW_DIAGNOSTIC",
			data: { raw: "RAW_DATA" },
		};
		const authority = modelAuthority(result);

		expect(authority).toContain("approved read result");
		expect(authority).not.toContain("RAW_DIAGNOSTIC");
		expect(authority).not.toContain("RAW_DATA");
	});

	it.each([
		[
			"exact",
			"Active task agents: one ready coding agent.",
			"Active task agents: one ready coding agent.",
		],
		[
			"truncated head",
			"Active task agents: one ready",
			"Active task agents: one ready coding agent.",
		],
		[
			"trailing addendum",
			"Active task agents: one ready coding agent. This is the raw result.",
			"Active task agents: one ready coding agent.",
		],
		[
			"scrubbed exact",
			"Active task agents: one ready at [path omitted].",
			"Active task agents: one ready at /private/runtime/task.ts.",
		],
	])(
		"rejects a %s observation echo from every user-reply candidate",
		async (_name, candidate, observation) => {
			const useModel = vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{ id: "read", name: "TASKS", arguments: { action: "list_agents" } },
					],
				})
				.mockResolvedValueOnce({ text: candidate, toolCalls: [] });
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: { id: "ctx", events: [] },
				tools: [{ name: "TASKS", description: "Read agent state." }],
				executeToolCall: async () => readResult(observation),
				evaluate: async () => ({
					success: true,
					decision: "FINISH",
					thought: "The read completed.",
					messageToUser: candidate,
				}),
			});

			expect(result.finalMessage).toBe(TOOL_RESULT_UNAVAILABLE_MESSAGE);
			expect(result.finalMessage).not.toContain(observation);
		},
	);

	it("keeps an archived observation inside the same echo gate", async () => {
		const observation = "Active task agents: one ready coding agent.";
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "read", name: "TASKS", arguments: { action: "list_agents" } },
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "reply", name: "REPLY", arguments: { text: observation } },
				],
			})
			.mockResolvedValueOnce({ text: observation, toolCalls: [] });
		let evaluations = 0;
		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx", events: [] },
			tools: [{ name: "TASKS", description: "Read agent state." }],
			config: {
				contextWindowTokens: 1,
				compactionReserveTokens: 0,
				compactionKeepSteps: 0,
			},
			executeToolCall: async () => readResult(observation),
			evaluate: async () => {
				evaluations += 1;
				return evaluations === 1
					? {
							success: false,
							decision: "CONTINUE" as const,
							thought: "Compose a fresh answer.",
						}
					: {
							success: true,
							decision: "FINISH" as const,
							thought: "The read completed.",
							messageToUser: observation,
						};
			},
		});

		expect(result.trajectory.archivedSteps).toHaveLength(1);
		expect(result.finalMessage).toBe(TOOL_RESULT_UNAVAILABLE_MESSAGE);
	});
});
