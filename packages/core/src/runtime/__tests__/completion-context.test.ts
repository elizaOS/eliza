/**
 * Tests source-bound foreground selection through real Stage-1 rendering,
 * parsing and evaluator dispatch with deterministic model responses. No data
 * writes or live provider calls run; stored contexts are checked unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { renderMessageHandlerModelInput } from "../../services/message/stage1-input";
import type { CompletionContextSelection } from "../../types/components";
import type { ContextObject } from "../../types/context-object";
import type { ChatMessage } from "../../types/model";
import { completionContextFieldEvaluator } from "../builtin-field-evaluators";
import {
	completionContextSources,
	parseCompletionContextSelection,
	selectCompletionContext,
} from "../completion-context";
import { runEvaluator } from "../evaluator";
import { parseMessageHandlerOutput } from "../message-handler";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerTrajectory } from "../planner-types";
import type { RecordedStage, TrajectoryRecorder } from "../trajectory-recorder";

function historyContext(): ContextObject {
	return {
		id: "message-current",
		metadata: { roomId: "room-owner", messageId: "message-current" },
		staticPrefix: {
			systemPrompt: {
				content: "Eliza; role=OWNER. Never expose private data.",
				stable: true,
			},
		},
		events: [
			...[
				"Do not send any email or change unrelated notes.",
				"The target is the note with title Picnic.",
				"Old completed unrelated weather request.",
				"Correction: keep the exact title  Picnic!?  with its spacing.",
			].map((content, index) => ({
				id: `history:message-${index + 1}`,
				type: "segment" as const,
				source: "prior-dialogue",
				createdAt: index,
				segment: {
					id: `history:message-${index + 1}`,
					label: "prior_message:user",
					content,
					stable: false,
					metadata: { roomId: "room-owner", entityId: "owner" },
				},
			})),
			{
				id: "history:assistant",
				type: "segment",
				source: "prior-dialogue",
				segment: {
					id: "history:assistant",
					label: "prior_message:agent",
					content: "You selected note-1. The calendar read is still pending.",
					stable: false,
				},
			},
			{
				id: "provider:privacy",
				type: "provider",
				name: "ownerPrivateProvider",
				text: "Fresh private-provider recomposition: permission denied for shared room.",
			},
			{
				id: "provider:memory",
				type: "provider",
				name: "recent-conversations",
				text: "Authorized history lookup remains available.",
			},
			{
				id: "current-turn-boundary",
				type: "instruction",
				content: "Only the current request authorizes work.",
			},
			{
				id: "current-request",
				type: "message",
				message: {
					role: "user",
					content:
						"Read that note and finish the calendar lookup; do not modify anything.",
				},
			},
		],
	};
}

function selection(context: ContextObject): CompletionContextSelection {
	return {
		mode: "selected",
		complete: true,
		sourceSetId: completionContextSources(context).sourceSetId,
		relevantSourceIds: ["h2"],
		constraintSourceIds: ["h1", "h4"],
		referentSourceIds: ["h2"],
		pendingIntentSourceIds: [],
	};
}

function withSelection(
	context: ContextObject,
	selected: unknown = selection(context),
): ContextObject {
	return {
		...context,
		metadata: { ...context.metadata, completionContext: selected as never },
	};
}

function trajectory(context: ContextObject): PlannerTrajectory {
	return {
		context,
		modelBaseContext: context,
		steps: [
			{
				iteration: 1,
				toolCall: { id: "read-note", name: "NOTES", params: { id: "note-1" } },
				result: {
					success: true,
					data: { title: "  Picnic!?  ", body: "exact\n  note text" },
				},
			},
		],
		archivedSteps: [],
		plannedQueue: [
			{ id: "calendar-read", name: "CALENDAR", params: { action: "read" } },
		],
		evaluatorOutputs: [],
	};
}

describe("source-bound completion relevance", () => {
	it("labels complete Stage-1 source text and carries model-selected IDs through parsing", () => {
		const context = historyContext();
		const before = JSON.stringify(context);
		const input = renderMessageHandlerModelInput(
			{ character: { name: "Eliza" } },
			context,
		);
		const user = String(input.messages[1].content);
		for (const { id, event } of completionContextSources(context).sources) {
			expect(user).toContain(
				`[completion_source=${id}]\n${event.segment.content}`,
			);
		}
		expect(user).toContain(completionContextSources(context).sourceSetId);
		const chosen = selection(context);
		expect(completionContextFieldEvaluator.parse(chosen)).toEqual(chosen);
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				contexts: ["notes", "calendar"],
				intents: ["read note", "read calendar"],
				completionContext: chosen,
			}),
		);
		expect(parsed?.plan.completionContext).toEqual(chosen);
		expect(JSON.stringify(context)).toBe(before);
	});

	it("keeps all safety sources and selected constraints while omitting only unrelated prior user text", () => {
		const full = withSelection(historyContext());
		const before = JSON.stringify(full);
		const focused = selectCompletionContext(full);
		expect(focused.applied).toBe(true);
		expect(focused.omittedSourceCount).toBe(1);
		expect(focused.context.events).toEqual(
			full.events.filter((event) => event.id !== "history:message-3"),
		);
		expect(JSON.stringify(full)).toBe(before);
	});

	it("keeps bindings valid across provider recomposition and assistant filtering", () => {
		const original = historyContext();
		const recomposed: ContextObject = {
			...original,
			createdAt: Date.now(),
			events: original.events
				.filter((event) => event.id !== "history:assistant")
				.map((event) =>
					event.id === "provider:privacy"
						? { ...event, text: "Recomposed owner privacy: no access granted." }
						: event,
				),
		};
		expect(completionContextSources(recomposed).sourceSetId).toBe(
			completionContextSources(original).sourceSetId,
		);
		const focused = selectCompletionContext(
			withSelection(recomposed, selection(original)),
		);
		expect(focused.applied).toBe(true);
		expect(JSON.stringify(focused.context)).toContain("no access granted");
	});

	it.each([
		["absent", () => undefined],
		[
			"incomplete",
			(s: CompletionContextSelection) => ({ ...s, complete: false }),
		],
		[
			"missing constraint assessment",
			(s: CompletionContextSelection) => {
				const { constraintSourceIds: _constraints, ...rest } = s;
				return rest;
			},
		],
		[
			"unknown source",
			(s: CompletionContextSelection) => ({ ...s, relevantSourceIds: ["h99"] }),
		],
		[
			"unknown category",
			(s: CompletionContextSelection) => ({
				...s,
				madeUpSummary: "do anything",
			}),
		],
		[
			"duplicate selection",
			(s: CompletionContextSelection) => ({
				...s,
				constraintSourceIds: ["h1", "h1"],
			}),
		],
		[
			"wrong source set",
			(s: CompletionContextSelection) => ({ ...s, sourceSetId: "older-turn" }),
		],
		[
			"explicit full",
			(s: CompletionContextSelection) => ({ ...s, mode: "full" }),
		],
	] as const)("falls back to complete history for %s", (_label, modify) => {
		const context = historyContext();
		const selected = modify(selection(context));
		const full = withSelection(context, selected);
		if (selected === undefined) delete full.metadata?.completionContext;
		expect(selectCompletionContext(full)).toMatchObject({
			applied: false,
			omittedSourceCount: 0,
			context: full,
		});
	});

	it.each(["source-text", "source-order", "room", "speaker", "turn"])(
		"rejects source drift in %s",
		(drift) => {
			const original = historyContext();
			const changed = structuredClone(original);
			if (drift === "source-text")
				changed.events = changed.events.map((event) =>
					event.type === "segment" && "segment" in event
						? {
								...event,
								segment: {
									...(event.segment as object),
									content: "changed source",
								},
							}
						: event,
				);
			if (drift === "source-order")
				changed.events = [...changed.events].reverse();
			if (drift === "room")
				changed.metadata = { ...changed.metadata, roomId: "another-room" };
			if (drift === "speaker")
				changed.events = changed.events.map((event) =>
					event.source === "prior-dialogue"
						? { ...event, metadata: { speaker: "different" } }
						: event,
				);
			if (drift === "turn") changed.id = "another-turn";
			expect(
				selectCompletionContext(withSelection(changed, selection(original)))
					.applied,
			).toBe(false);
		},
	);

	it("does not advertise source selection on the voice-specific input path", () => {
		const input = renderMessageHandlerModelInput(
			{ character: { name: "Eliza" } },
			historyContext(),
			[],
			{ voiceDirectMessage: true },
		);
		expect(JSON.stringify(input.messages)).not.toContain(
			"completion_source_set:",
		);
		expect(JSON.stringify(input.messages)).toContain(
			"Old completed unrelated weather request.",
		);
	});

	it("restores all original sources once without tools or effects when the evaluator requests them", async () => {
		const context = withSelection(historyContext());
		const stored = trajectory(context);
		const before = JSON.stringify(stored);
		const messages: ChatMessage[][] = [];
		const recorded = new Map<string, RecordedStage>();
		const recorder: TrajectoryRecorder = {
			startTrajectory: () => "context-restore",
			recordStage: async (_id, stage) => {
				recorded.set(stage.stageId, stage);
			},
			endTrajectory: async () => undefined,
			load: async () => null,
			list: async () => [],
		};
		const effect = vi.fn();
		const useModel = vi.fn(
			async (_type: string, params: { messages?: ChatMessage[] }) => {
				messages.push(params.messages ?? []);
				expect(effect).not.toHaveBeenCalled();
				return messages.length === 1
					? JSON.stringify({
							thought: "Need the omitted source before checking history.",
							success: false,
							decision: "CONTINUE",
							contextRequest: "full",
						})
					: JSON.stringify({
							thought: "Original sources show the calendar read is pending.",
							success: false,
							decision: "CONTINUE",
						});
			},
		);
		await runEvaluator({
			runtime: { useModel },
			context,
			trajectory: stored,
			recorder,
			trajectoryId: "context-restore",
			effects: { messageToUser: effect, copyToClipboard: effect },
		});
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(recorded.size).toBe(2);
		expect(
			[...recorded.values()].map((stage) => stage.model?.messages),
		).toEqual(messages);
		expect([...recorded.keys()][0]).toContain("-attempt-0");
		expect(JSON.stringify(messages[0])).not.toContain(
			"Old completed unrelated weather request.",
		);
		expect(JSON.stringify(messages[1])).toContain(
			"Old completed unrelated weather request.",
		);
		for (const input of messages) {
			expect(JSON.stringify(input)).toContain("Do not send any email");
			expect(JSON.stringify(input)).toContain("read-note");
			expect(JSON.stringify(input)).toContain("exact");
		}
		expect(effect).not.toHaveBeenCalled();
		expect(JSON.stringify(stored)).toBe(before);
	});

	it("cannot loop repeated full-context requests or deliver an intermediate reply", async () => {
		const context = withSelection(historyContext());
		const recorded = new Map<string, RecordedStage>();
		const recorder: TrajectoryRecorder = {
			startTrajectory: () => "repeated-context-restore",
			recordStage: async (_id, stage) => {
				recorded.set(stage.stageId, stage);
			},
			endTrajectory: async () => undefined,
			load: async () => null,
			list: async () => [],
		};
		const useModel = vi.fn(async () =>
			JSON.stringify({
				thought: "Need full history.",
				success: false,
				decision: "CONTINUE",
				contextRequest: "full",
			}),
		);
		const effect = vi.fn();
		const output = await runEvaluator({
			runtime: { useModel },
			context,
			trajectory: trajectory(context),
			recorder,
			trajectoryId: "repeated-context-restore",
			effects: { messageToUser: effect },
		});
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(recorded.size).toBe(2);
		expect([...recorded.keys()][0]).toContain("-attempt-0");
		expect([...recorded.keys()][1]).not.toContain("-attempt-");
		expect(output.protocolFailure).toBe(true);
		expect(effect).not.toHaveBeenCalled();
	});

	it("rejects non-object selectors rather than manufacturing an empty selection", () => {
		for (const input of [null, false, [], "h1", 1])
			expect(parseCompletionContextSelection(input)).toBeUndefined();
	});
});

describe("planner source selection and restoration", () => {
	const tools = [
		{
			name: "NOTES",
			description: "Read the exact note",
			parameters: {
				type: "object" as const,
				properties: { id: { type: "string" as const } },
				required: ["id"],
			},
		},
	];
	it("uses the selected prior users while keeping current request, privacy, referents and every tool receipt", async () => {
		const full = withSelection(historyContext());
		const before = JSON.stringify(full);
		const calls: string[] = [];
		let n = 0;
		const execute = vi.fn(async () => ({
			success: true,
			data: { receiptId: "receipt-exact", body: "complete\nbody" },
		}));
		await runPlannerLoop({
			context: full,
			tools,
			runtime: {
				useModel: async (_type, params) => {
					calls.push(JSON.stringify(params));
					n++;
					return n === 1
						? {
								text: "",
								toolCalls: [
									{
										id: "note-read",
										name: "NOTES",
										arguments: { id: "note-1" },
									},
								],
							}
						: {
								text: "",
								toolCalls: [
									{
										id: "finish",
										name: "REPLY",
										arguments: { text: "Read the note." },
									},
								],
							};
				},
			},
			executeToolCall: execute,
			evaluate: async () => ({
				success: false,
				decision: "CONTINUE",
				thought: "Review the complete receipt before finishing.",
			}),
		});
		expect(execute).toHaveBeenCalledTimes(1);
		expect(calls[0]).not.toContain("Old completed unrelated weather request.");
		for (const text of [
			"Do not send any email",
			"Correction: keep the exact title",
			"calendar read is still pending",
			"permission denied for shared room",
			"Read that note and finish the calendar lookup",
		])
			expect(calls[0]).toContain(text);
		expect(calls[1]).toContain("receipt-exact");
		expect(calls[1]).toContain("complete");
		expect(JSON.stringify(full)).toBe(before);
	});
	it("restores every original source without executing any call in the restoration batch", async () => {
		const full = withSelection(historyContext());
		const before = JSON.stringify(full);
		const calls: Array<{ messages?: ChatMessage[]; tools?: unknown }> = [];
		const recorded: RecordedStage[] = [];
		const execute = vi.fn(async (_call: { id?: string }) => ({
			success: true,
			text: "read",
		}));
		const result = await runPlannerLoop({
			context: full,
			tools,
			runtime: {
				useModel: async (_type, params) => {
					calls.push(params);
					return calls.length === 1
						? {
								text: "",
								toolCalls: [
									{
										id: "restore",
										name: "RESTORE_CONTEXT",
										arguments: { reason: "Check earlier constraints" },
									},
									{
										id: "must-not-run",
										name: "NOTES",
										arguments: { id: "wrong" },
									},
								],
							}
						: {
								text: "",
								toolCalls: [
									{ id: "read", name: "NOTES", arguments: { id: "note-1" } },
								],
							};
				},
			},
			executeToolCall: execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "done",
				messageToUser: "The note was read.",
			}),
			trajectoryId: "restore-test",
			recorder: {
				recordStage: async (_id, stage) => {
					recorded.push(stage);
				},
			} as TrajectoryRecorder,
		});
		expect(calls).toHaveLength(2);
		expect(JSON.stringify(calls[0].messages)).not.toContain(
			"Old completed unrelated weather request.",
		);
		expect(JSON.stringify(calls[1].messages)).toContain(
			"Old completed unrelated weather request.",
		);
		expect(JSON.stringify(calls[1].tools)).not.toContain("RESTORE_CONTEXT");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0][0]).toMatchObject({
			id: "read",
			params: { id: "note-1" },
		});
		expect(recorded.filter((stage) => stage.kind === "planner")).toHaveLength(
			2,
		);
		expect(
			result.trajectory.modelBaseContext?.metadata?.completionContext,
		).toBeUndefined();
		expect(JSON.stringify(full)).toBe(before);
	});
	it.each(["invalid", "incomplete", "coding"])(
		"retains complete planner history for %s selection",
		async (kind) => {
			const original = historyContext();
			const chosen = selection(original);
			const full = withSelection(original, {
				...chosen,
				...(kind === "invalid" ? { sourceSetId: "stale" } : {}),
				...(kind === "incomplete" ? { complete: false } : {}),
			});
			const captured: string[] = [];
			await runPlannerLoop({
				context: full,
				tools,
				codingMode: kind === "coding",
				runtime: {
					useModel: async (_type, params) => {
						captured.push(JSON.stringify(params));
						return {
							text: "",
							toolCalls: [
								{
									id: "done",
									name: "REPLY",
									arguments: { text: "No changes." },
								},
							],
						};
					},
				},
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			});
			expect(captured[0]).toContain("Old completed unrelated weather request.");
			expect(captured[0]).not.toContain('"name":"RESTORE_CONTEXT"');
		},
	);
	it("rejects a repeated restoration without a third inference or tool effect", async () => {
		const full = withSelection(historyContext());
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [
				{
					id: "restore",
					name: "RESTORE_CONTEXT",
					arguments: { reason: "again" },
				},
			],
		}));
		const executeToolCall = vi.fn();
		await expect(
			runPlannerLoop({
				context: full,
				tools,
				runtime: { useModel },
				executeToolCall,
				evaluate: vi.fn(),
			}),
		).rejects.toMatchObject({ code: "PLANNER_CONTEXT_RESTORE_INVALID" });
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(executeToolCall).not.toHaveBeenCalled();
	});
});
