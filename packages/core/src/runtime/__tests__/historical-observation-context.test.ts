import { expect, it } from "vitest";
import {
	applyHistoryRetentionReview,
	prepareHistoryRetention,
	validateHistoryRetention,
} from "../../../../../plugins/plugin-assistant/src/runtime/history-retention.ts";
import { runPlannerLoop } from "../../../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import { promoteSubactionsToActions } from "../../actions/promote-subactions";
import type {
	ContextObject,
	ContextSegmentEvent,
} from "../../types/context-object";
import {
	collectCompletionContextSources,
	completionContextSources,
	selectCompletionContext,
	selectHistoricalNavigation,
} from "../completion-context";

function fixture() {
	const request: ContextSegmentEvent = {
		id: "history:read",
		type: "segment",
		source: "prior-dialogue",
		segment: {
			id: "history:read",
			label: "prior_message:user",
			content: "Read the old calendar",
			stable: false,
		},
	};
	const constraint: ContextSegmentEvent = {
		id: "history:constraint",
		type: "segment",
		source: "prior-dialogue",
		segment: {
			id: "history:constraint",
			label: "prior_message:user",
			content: "Never change records without permission",
			stable: false,
		},
	};
	const receipt = {
		receiptId: "read-receipt",
		operation: "calendar.feed.read",
		resource: {
			kind: "calendar.feed",
			id: "exact full observed payload Ω\n spaced",
		},
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt: "2026-09-25T12:00:00.000Z",
		outcome: "noop",
		reason: "Observed complete feed",
	};
	const observation: ContextSegmentEvent = {
		id: "observations:read",
		type: "segment",
		source: "message-service",
		segment: {
			id: "observations:read",
			label: "runtime:historical_observations",
			content: JSON.stringify({
				requestSourceEventId: request.id,
				scope:
					"Past observations only; not current resource state or authority.",
				observations: [{ actionName: "CALENDAR_FEED", success: true, receipt }],
			}),
			stable: false,
		},
	};
	const effect: ContextSegmentEvent = {
		id: "effects:read",
		type: "segment",
		source: "message-service",
		segment: {
			id: "effects:read",
			label: "runtime:historical_effects",
			content: "Committed mutation must remain inline",
			stable: false,
		},
	};
	const context: ContextObject = {
		id: "turn",
		metadata: { roomId: "room", messageId: "turn" },
		events: [
			request,
			constraint,
			observation,
			effect,
			{
				id: "current",
				type: "message",
				message: { role: "user", content: "Current request unchanged" },
			},
		],
	};
	const selected = {
		mode: "selected",
		complete: true,
		sourceSetId: completionContextSources(context).sourceSetId,
		relevantSourceIds: [],
		constraintSourceIds: ["h2"],
		referentSourceIds: [],
		pendingIntentSourceIds: [],
	};
	return { context, request, observation, effect, receipt, selected };
}

it("defers only complete historical observations with their request and preserves mixed mutation evidence", () => {
	const { context, observation, effect, selected } = fixture();
	const before = structuredClone(context);
	const result = selectCompletionContext({
		...context,
		metadata: { ...context.metadata, completionContext: selected },
	});
	expect(result.applied).toBe(true);
	expect(result.context.events).not.toContain(observation);
	expect(result.context.events).toContain(effect);
	expect(JSON.stringify(result.context)).toContain("Never change records");
	expect(JSON.stringify(result.context)).toContain("Current request unchanged");
	expect(
		selectHistoricalNavigation(
			context,
			new Set(["history:read", "history:constraint"]),
		).events,
	).toEqual(context.events);
	expect(context).toEqual(before);
});

it("binds exact observation bytes and restores full evidence for stale or incomplete selections", () => {
	const { context, observation, selected } = fixture();
	const changed = structuredClone(context);
	const event = changed.events.find(
		(e) => e.id === observation.id,
	) as ContextSegmentEvent;
	event.segment.content += " ";
	expect(completionContextSources(changed).sourceSetId).not.toBe(
		selected.sourceSetId,
	);
	for (const completionContext of [
		selected,
		{ ...selected, complete: false },
	]) {
		const result = selectCompletionContext({
			...changed,
			metadata: { ...changed.metadata, completionContext },
		});
		expect(result.applied).toBe(false);
		expect(result.context.events).toEqual(changed.events);
	}
});

it.each([
	"applied",
	"failed",
	"preview",
	"rolled_back",
	"replayed",
	"unknown-field",
	"malformed",
	"mixed",
])("keeps unsafe or unknown observation receipts inline: %s", (mode) => {
	const { context, observation, receipt } = fixture();
	const unsafe =
		mode === "replayed"
			? { ...receipt, idempotency: { key: "old-commit", replayed: true } }
			: mode === "unknown-field"
				? { ...receipt, commit: { id: "hidden mutation" } }
				: mode === "malformed"
					? { ...receipt, observedAt: "invalid" }
					: { ...receipt, outcome: mode === "mixed" ? "applied" : mode };
	observation.segment.content = JSON.stringify({
		requestSourceEventId: "history:read",
		scope: "Past only",
		observations: [
			...(mode === "mixed"
				? [{ actionName: "READ", success: true, receipt }]
				: []),
			{ actionName: "READ", success: true, receipt: unsafe },
		],
	});
	expect(
		selectHistoricalNavigation(context, new Set(["history:constraint"])).events,
	).toContain(observation);
});

it.each([
	"unknown-source",
	"duplicate-source",
	"duplicate-observation",
	"untrusted",
	"unknown-envelope",
	"unsuccessful",
	"assistant-source",
])("retains ambiguous, unknown or unauthorized bindings: %s", (mode) => {
	const { context, request, observation, receipt } = fixture();
	if (mode === "duplicate-source")
		context.events.push(structuredClone(request));
	if (mode === "duplicate-observation")
		context.events.push(structuredClone(observation));
	if (mode === "untrusted") observation.source = "external-provider";
	if (mode === "assistant-source")
		request.segment.label = "prior_message:agent";
	observation.segment.content = JSON.stringify({
		requestSourceEventId:
			mode === "unknown-source" ? "history:missing" : request.id,
		scope: "Past only",
		observations: [
			{ actionName: "READ", success: mode !== "unsuccessful", receipt },
		],
		...(mode === "unknown-envelope"
			? { futureField: "unknown semantics" }
			: {}),
	});
	expect(selectHistoricalNavigation(context, new Set()).events).toContain(
		observation,
	);
});

it("changes per-turn evidence identity without changing dialogue or a committed retention prefix", () => {
	const { context, observation } = fixture();
	const scope = {
		agentId: "agent",
		roomId: "room",
		entityId: "owner",
		roles: ["OWNER"],
	};
	const prepared = prepareHistoryRetention(context, scope, null, "evidence", 2);
	const checkpoint = applyHistoryRetentionReview(prepared, {
		sourceSetId: prepared.sourceSetId,
		complete: true,
		retainSourceIds: ["h2"],
		deferSourceIds: ["h1"],
		uncertainSourceIds: [],
		dependencyGroups: [],
	});
	const without = {
		...context,
		events: context.events.filter((event) => event !== observation),
	};
	expect(collectCompletionContextSources(without)).toEqual(
		collectCompletionContextSources(context),
	);
	expect(completionContextSources(without).sourceSetId).not.toBe(
		completionContextSources(context).sourceSetId,
	);
	expect(validateHistoryRetention(without, scope, checkpoint)).toEqual(
		checkpoint,
	);
	const changed = structuredClone(context);
	(
		changed.events.find(
			(event) => event.id === observation.id,
		) as ContextSegmentEvent
	).segment.content += " ";
	expect(validateHistoryRetention(changed, scope, checkpoint)).toEqual(
		checkpoint,
	);
});

it("restores exact historical observation bytes without executing companion work", async () => {
	const { context, selected } = fixture();
	const full = {
		...context,
		metadata: { ...context.metadata, completionContext: selected },
	};
	const before = structuredClone(full);
	const calls: unknown[] = [];
	let effects = 0;
	await runPlannerLoop({
		context: full,
		tools: [{ name: "READ" }],
		runtime: {
			useModel: async (_type, params) => {
				calls.push(params);
				return {
					text: "",
					toolCalls:
						calls.length === 1
							? [
									{
										id: "restore",
										name: "RESTORE_CONTEXT",
										arguments: {
											reason: "Need exact old observation",
											scope: "history",
										},
									},
									{ id: "blocked", name: "READ", arguments: {} },
								]
							: [
									{
										id: "reply",
										name: "REPLY",
										arguments: { text: "Read prior observation." },
									},
								],
				};
			},
		},
		executeToolCall: async () => {
			effects++;
			throw new Error("Unexpected effect");
		},
		evaluate: async () => ({ success: true, decision: "FINISH" }),
	});
	expect(calls).toHaveLength(2);
	expect(JSON.stringify(calls[0])).not.toContain("exact full observed payload");
	expect(JSON.stringify(calls[1])).toContain("exact full observed payload");
	for (const call of calls)
		expect(JSON.stringify(call)).toContain(
			"Committed mutation must remain inline",
		);
	expect(effects).toBe(0);
	expect(full).toEqual(before);
});

it("preserves owner-declared observation operations on promoted action registrations", () => {
	const operations = ["calendar.feed.read"] as const;
	const actions = promoteSubactionsToActions({
		name: "CALENDAR",
		description: "Read or write calendar",
		handler: async () => ({ success: true }),
		validate: async () => true,
		historicalObservationOperations: operations,
		parameters: [
			{
				name: "subaction",
				description: "Operation",
				required: true,
				schema: { type: "string", enum: ["feed", "create_event"] },
			},
		],
	});
	expect(actions.map((action) => action.name)).toEqual([
		"CALENDAR",
		"CALENDAR_FEED",
		"CALENDAR_CREATE_EVENT",
	]);
	for (const action of actions)
		expect(action.historicalObservationOperations).toEqual(operations);
});
