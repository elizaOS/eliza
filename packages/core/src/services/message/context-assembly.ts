/** Assembles message context from ordered dialogue, selected providers, and the authorized action surface. */

import { v4 } from "uuid";
import { actionToTool, CORE_PLANNER_TERMINALS } from "../../actions/to-tool";
import { canActionRun } from "../../runtime/action-gate";
import { satisfiesRoleGate } from "../../runtime/context-gates";
import { createContextObject } from "../../runtime/context-object";
import {
	buildCanonicalSystemPrompt,
	buildCharacterStyleDirections,
} from "../../runtime/system-prompt";
import type { Action, AgentContext } from "../../types/components";
import type { ContextEvent, ContextObject } from "../../types/context-object";
import type { ContextDefinition, RoleGateRole } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import { MESSAGE_SOURCE_TRIGGER_PROMPT } from "../../types/message-source";
import type { ToolDefinition } from "../../types/model";
import type { JsonValue } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import {
	collectV5PlannerCandidateActions,
	type V5PlannerActionSurface,
} from "./action-surface.js";
import { createContextCatalogReadEvent } from "./context-catalog.js";
import {
	appendPriorDialogueEvents,
	appendStateProviderEvents,
	currentMessageContentForContext,
	hasStructuredRecentMessagesProvider,
	replyReferenceEventForContext,
} from "./dialogue-context.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import {
	MODEL_CONTEXT_PROVIDER_EXCLUSIONS,
	stage1ResponseStateProviderNames,
} from "./provider-state.js";

/** One owner for the current-turn policy; source-reference capability changes
 * only its recall guidance, preserving the same request and effect boundary. */
export function buildCurrentTurnBoundary({
	includeTools = false,
	hasMemoryRecallSurface,
	hasOriginalReferences = false,
}: {
	includeTools?: boolean;
	hasMemoryRecallSurface: boolean;
	hasOriginalReferences?: boolean;
}): string {
	if (includeTools) {
		return "current_turn_boundary: Execute only the final message:user. Prior dialogue/reply_reference resolves references, continuations, recall and corrections, not pending commands or current state. prior_message:agent is your own earlier speech; later uncertainty does not erase earlier evidence. Keep people distinct. Retrieve missing originals through authorized memory tools rather than asking for accessible history. Stage 1 selected tools: verify live data/effects with this turn's results, never substitute old replies or claim unexecuted work.";
	}
	const recall = hasOriginalReferences
		? 'Read missing originals through contextRequests=["history:hN"], or "history:all" when the source is unknown, interpretation uncertain or all originals are needed. Recall itself authorizes these same-conversation reads, including when app/storage tools are disallowed. Selected blocks are not all dialogue: omitted does not mean absent. These reads access neither other rooms nor live records/effects. Original assistant messages establish what you said; resolve missing references before asserting absence. Explicit stored-record searches/repeated lookups, missing stored metadata and stored-record counts still need authorized memory retrieval.'
		: hasMemoryRecallSurface
			? "Quote supplied originals/authors directly for recall. Explicit stored-message searches/repeated lookups, missing evidence or requested metadata, and exhaustive counts require current authorized memory retrieval: select memory, search intents and its candidate action. If lookup is forbidden, use supplied evidence and state remaining gaps. Dialogue/FACTS alone do not prove exhaustive stored-record coverage."
			: "No separate chat-history search is available this turn. If supplied dialogue/FACTS cannot answer, state that limited scope without inventing a search. Decline exhaustive totals or label visible matches as partial with older history unverified. This limitation does not restrict available task/build/deploy/sub-agent status tools.";
	return (
		"current_turn_boundary: The prior_message blocks above are context only. Execute/answer only final message:user; include prior work only when it references that work. reply_reference identifies the message being replied to, not a new command. For literal recall, use supplied dialogue, current-message facts and FACTS; request advertised FACTS when needed. Apply later corrections, keep speakers distinct, and ground claims about your own speech in prior_message:agent/original assistant text. Later uncertainty does not erase earlier evidence. " +
		"verified_cross_room_message is authorized linked-private-room evidence: literal message/attachment-description/transcript facts permit direct recall without attachment/calendar inspection; never invent details or reveal private attachment URLs. Recall proves historical speech, not current records. Tracked tasks/todos/reminders/habits/goals/Notes/day/week status needs live tasks/record tools; never infer an empty day from missing chat. " +
		recall +
		" For current task/build/deploy/agent-run outcomes or disputes, select non-simple contexts, verification intents and matching tools; check available status before claiming success, conceding failure or saying verification is impossible. Never claim a search or effect that did not execute."
	);
}

export async function createV5MessageContextObject(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	selectedContexts?: readonly AgentContext[];
	includeTools?: boolean;
	/** Context purpose is independent of whether this call exposes tools. */
	providerPhase?: "response" | "planning" | "completion";
	/** A framework catalog reference was requested earlier in this turn. */
	includeContextCatalog?: boolean;
	/** Per-turn routing catalog for the response handler, which has no action tools. */
	includeActionDiscovery?: boolean | "index" | "reference";
	userRoles?: readonly RoleGateRole[];
	availableContexts?: readonly ContextDefinition[];
	extraProviderExclusions?: readonly string[];
	preselectedActions?: readonly Action[];
	actionSurface?: V5PlannerActionSurface;
	/**
	 * Structural "this turn does not address the agent" signal (the
	 * isUnaddressedTextGroupTurn classifier — channel type + addressing +
	 * source metadata, never message text). When set, the rendered context
	 * carries the ambient-turn policy instruction; absent/false renders
	 * byte-identical to before, so addressed turns are untouched.
	 */
	ambientTurn?: boolean;
	/**
	 * When the ambient turn's effective reply_gate is the restrained
	 * `addressed_or_ambient` mode, Stage-1 renders the HARD-GATE IGNORE bias;
	 * otherwise the participatory default policy renders (no @-mention needed,
	 * model judges each turn on concrete value).
	 */
	ambientHardGate?: boolean;
	/** Trusted same-speaker continuation after a recent correction of this agent. */
	peerCorrectionContinuation?: boolean;
}): Promise<ContextObject> {
	const events: ContextEvent[] = [];
	const responseDecision = args.providerPhase
		? args.providerPhase === "response"
		: !args.includeTools;
	// Presence and role gates advertise presentation support without loading its grammar.
	const channelType = args.message.content.channelType;
	if (
		responseDecision &&
		(!channelType || channelType === "DM" || channelType === "API") &&
		args.runtime.providers?.some(
			(provider) =>
				["uiWidgetCapabilities", "uiWidgets", "uiGenerative"].includes(
					provider.name,
				) &&
				!provider.private &&
				satisfiesRoleGate(args.userRoles, provider.roleGate) &&
				satisfiesRoleGate(args.userRoles, provider.contextGate?.roleGate),
		)
	) {
		events.push({
			id: "rich-reply-support",
			type: "instruction",
			source: "message-service",
			stable: true,
			content:
				'Rich-reply support is available. Showing/rendering an inline setup card, form, widget or dashboard requires later reply composition: select contexts=["general"], intents=[], candidateActionNames=[], replyEffectStatus="pending", and a brief acknowledgment. Planning/completion reads the formatting reference and renders the requested controls; the acknowledgment alone is not completion. VIEWS_SHOW navigates app views, not inline cards. Select domain/navigation actions only for separately requested record work or app-view navigation. Do not author widget markup or claim a card was opened in Stage 1.',
		});
	}

	const renderExclusions = [
		...MODEL_CONTEXT_PROVIDER_EXCLUSIONS,
		...(args.extraProviderExclusions ?? []),
		// The recent-messages provider exposes structured prior turns in
		// data.recentMessages. appendPriorDialogueEvents renders those as proper
		// chat-message events, so also rendering provider.text would duplicate the
		// same conversation and can leak stored assistant thought/action metadata
		// into the prompt. Keep the text fallback only for legacy/unstructured
		// provider states.
		...(hasStructuredRecentMessagesProvider(args.state)
			? ["RECENT_MESSAGES"]
			: []),
	];
	appendStateProviderEvents(
		events,
		args.state,
		renderExclusions,
		args.runtime.providers,
		!responseDecision
			? undefined
			: stage1ResponseStateProviderNames(
					args.runtime,
					args.message,
					args.userRoles,
				),
	);

	if (args.includeContextCatalog) {
		events.push(
			await createContextCatalogReadEvent(args.runtime, args.message),
		);
	}

	if (hasStructuredRecentMessagesProvider(args.state)) {
		events.push({
			id: "prior-dialogue-policy",
			type: "segment",
			source: "message-service",
			segment: {
				id: "prior-dialogue-policy",
				label: "system",
				content:
					"prior_dialogue_policy: Prior chat is context only. For current, latest, live, filesystem, runtime, build, deploy, or verification requests, use the current turn's tools/context instead of answering from prior tool results or stale sub-agent transcripts.",
				stable: true,
			},
		});
	}

	// Planning and restoration need the same complete historical dialogue as
	// interpretation. Prior answers remain history, never current effect proof.
	appendPriorDialogueEvents(events, args.runtime, args.state, args.message, {
		includeOwnReplies: true,
	});

	// Advertise recall only for an authorized search child or search-capable umbrella.
	const hasMemoryRecallSurface =
		(args.availableContexts ?? []).some((context) => context.id === "memory") &&
		(args.runtime.actions ?? []).some((action) => {
			const actionName = normalizeActionIdentifier(action.name);
			if (actionName !== "MEMORY" && actionName !== "MEMORYSEARCH") {
				return false;
			}
			const searchDiscriminator = action.parameters?.some((parameter) => {
				const name = normalizeActionIdentifier(parameter.name);
				if (name !== "ACTION" && name !== "OP") {
					return false;
				}
				// schema is required by ActionParameter, but an untyped third-party
				// plugin can register a malformed parameter; a capability probe must
				// not throw on it.
				return [
					...(parameter.schema?.enum ?? []),
					...(parameter.schema?.enumValues ?? []),
				].some((value) => normalizeActionIdentifier(value) === "SEARCH");
			});
			return (
				(actionName === "MEMORYSEARCH" || searchDiscriminator === true) &&
				canActionRun(action, {
					message: args.message,
					activeContexts: ["memory"],
					userRoles: args.userRoles,
				})
			);
		});
	events.push({
		id: "current-turn-boundary",
		type: "instruction",
		source: "message-service",
		stable: false,
		content: buildCurrentTurnBoundary({
			includeTools: args.includeTools,
			hasMemoryRecallSurface,
		}),
	});

	// Prompt automations execute without a visible human message; their reply is
	// the delivered result. Make that boundary explicit so the model performs
	// the instruction instead of acknowledging framing the recipient never sees.
	if (args.message.content.source === MESSAGE_SOURCE_TRIGGER_PROMPT) {
		events.push({
			id: "trigger-automation-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				'trigger_automation_policy: The final message:user below is a scheduled automation of yours firing, not a person talking to you. Its "Do this now:" clause is the instruction you must carry out on this turn, and whatever you reply is delivered to the user as the automation\'s output. Produce that output: if the instruction is to remind, the reply IS the reminder addressed to the user — phrase it in your voice so it reads as a reminder arriving (lead with something like "reminder:" or equivalent), never a bare echo of the item text alone; if it is to check or report something, run the needed tools and reply with the result. Never reply with an acknowledgement of the instruction itself ("noted.", "got it", "will do") — the user never sees the instruction, so an acknowledgement reaches them as a bare non-sequitur.',
		});
	}

	// Ambient-turn policy (live incident tj-f637475edcb7bd): on an unaddressed
	// group turn the planner ran, produced no tool activity, and still shipped
	// a filler completion as the reply. Nothing in the planner prompt told the
	// model the turn was ambient, so "end the turn" read as "compose a status".
	// Rendered only when the caller's structural classifier flagged the turn
	// ambient — addressed turns (and callers that do not pass the flag) render
	// byte-identical context, and the IGNORE terminal invoked here already
	// flows to deliberate, recorded non-delivery (see the ambient
	// deliberate-silence terminal in runV5MessageRuntimeStage1).
	//
	// The instruction names the SHAPE of a process description and quotes no
	// sentence. It used to quote HANDLED_STEP_FALLBACK_MESSAGE as its negative
	// example, which bought nothing: that string is runtime-emitted, so no
	// instruction could suppress it, while an emittable forbidden sentence
	// sitting in context is a live hazard on weak models. The guarantee is
	// structural now, in the terminal named above.
	if (args.ambientTurn) {
		events.push({
			id: "ambient-turn-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content: args.includeTools
				? "ambient_turn_policy: The final message:user below was not addressed to you — it is other participants talking to each other, and no reply is expected from you. Contribute only if this turn's work produced something concrete and useful to those participants (a tool result, a substantive answer to what they are discussing). If your work yields nothing concrete to contribute, end the turn by calling the IGNORE tool — deliberate silence — instead of composing a reply. Never send a status update, a progress note, or a description of your own process as the reply — any sentence whose subject is what you did, tried, handled, or checked rather than what they are discussing: on an unaddressed message, an empty outcome means silence."
				: args.ambientHardGate
					? // Restrained opt-in (reply_gate=addressed_or_ambient): the
						// quiet-ambient bias, kept for rooms that want it. Live group-chat
						// evaluation (five ambient-mode rooms, gemma-4-31b) replied to
						// nearly every unaddressed message — "Hard to miss.", "Sounds
						// like the move." — a running commentary nobody asked for; this
						// mode keeps that hard IGNORE default.
						"ambient_turn_policy: HARD GATE. The final message:user below was not addressed to you — it is other participants talking to each other, and no reply is expected from you. Default shouldRespond=IGNORE. You MUST set shouldRespond=IGNORE unless the current turn explicitly challenges or asks to clarify your immediately preceding prior_message:agent reply, silence would allow a concrete consequential error or harm you can specifically prevent, or an explicit standing responsibility makes this turn yours to handle. A broadcast question, a useful fact you could add, your ability to answer, or your desire to keep the discussion moving is never enough. IGNORE banter, jokes, reactions, acknowledgements, open group questions, and side chatter where you would only answer, agree, comment, restate, or continue the conversation. Having replied earlier is a reason to stay silent unless the current turn directly challenges or needs clarification of that reply."
					: // Participatory default: no @-mention required — the agent is a
						// full participant and judges each unaddressed turn on concrete
						// value. Chatter still resolves to IGNORE, so ambient rooms get
						// contribution, not commentary.
						"ambient_turn_policy: The final message:user below was not addressed to you — it is other participants talking to each other. You are a full participant in this room and need no @-mention to reply, but replying is optional: judge each turn on concrete value. Set shouldRespond=RESPOND when you can add something genuinely useful — answer a question you can answer well, correct a consequential error, supply a fact or next step the discussion is missing. Set shouldRespond=IGNORE for banter, jokes, reactions, acknowledgements, and side chatter where you would only agree, restate, or keep the conversation moving. Do not reply to every message; when you do reply, be brief and on-topic.",
		});
	}
	if (args.peerCorrectionContinuation) {
		events.push({
			id: "peer-correction-continuation-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				"peer_correction_continuation_policy: Trusted recent-message structure shows that the current participant corrected your last contribution and is now continuing within the same short exchange. Set shouldRespond=RESPOND. Follow the correction in a brief, natural acknowledgment; do not repeat the behavior they corrected or add unsolicited advice.",
		});
	}

	// A fired prompt-automation is an INSTRUCTION to carry out now, not a
	// notification to acknowledge. Live incident 2026-08-05 01:00: a "take
	// vitamins" reminder fired and the turn replied "noted." — the model read
	// "Scheduled trigger ... fired. Do this now: <instructions>" as a status
	// message about itself and acknowledged it, so the user got an
	// acknowledgement instead of the reminder. Gated on the connector-set
	// source (never on message text), the same structural shape the ambient
	// classifier uses: the reply of an automation turn IS its user-facing
	// output.
	if (args.message.content.source === MESSAGE_SOURCE_TRIGGER_PROMPT) {
		events.push({
			id: "trigger-automation-policy",
			type: "instruction",
			source: "message-service",
			stable: false,
			content:
				'trigger_automation_policy: The final message:user below is a scheduled automation of yours firing, not a person talking to you. Its "Do this now:" clause is the instruction you must carry out on this turn, and whatever you reply is delivered to the user as the automation\'s output. Produce that output: if the instruction is to remind, the reply IS the reminder addressed to the user — phrase it in your voice so it reads as a reminder arriving (lead with something like "reminder:" or equivalent), never a bare echo of the item text alone; if it is to check or report something, run the needed tools and reply with the result. Never reply with an acknowledgement of the instruction itself ("noted.", "got it", "will do") — the user never sees the instruction, so an acknowledgement reaches them as a bare non-sequitur.',
		});
	}

	if (args.includeActionDiscovery) {
		const referenceOnly = args.includeActionDiscovery === "reference";
		const actions = referenceOnly
			? []
			: await collectV5PlannerCandidateActions({
					runtime: args.runtime,
					message: args.message,
					state: args.state,
					selectedContexts: args.selectedContexts,
					userRoles: args.userRoles,
					discoverActions: true,
				});
		// Full reference text and schemas are read
		// through the existing permission-checked planner discovery protocol.
		const fullCatalog = JSON.stringify(
			actions.map((action) => ({
				name: action.name,
				description: action.description,
				contexts: action.contexts,
				similes: action.similes,
			})),
		);
		const index = [
			// This is a name lookup index, not the planner's relevance ranking.
			// Keep equal authorized sets byte-identical when the active view changes.
			JSON.stringify(actions.map((action) => action.name).sort()),
			"All currently authorized action names are listed above. For a known operation, name its exact action in candidateActionNames. When descriptions or aliases are needed to identify or explain a capability, select DISCOVER_TOOLS and a non-simple context: the planner can read complete descriptions with names=[] and load complete schemas by exact name. Do not infer that an unfamiliar name means a capability is absent. Discovery is reference reading, never execution or permission. A conversational reply needs no discovery.",
		].join("\n");
		events.push({
			id: "available-actions",
			type: "segment",
			source: "message-service",
			segment: {
				id: "available-actions",
				label: "available_actions",
				stable: false,
				content: referenceOnly
					? "For a known operation, name its exact action in candidateActionNames; the planner validates availability and loads its schema. Do not add DISCOVER_TOOLS when those hints already identify the operation. When descriptions or aliases are needed to identify or explain an unfamiliar capability, put DISCOVER_TOOLS in candidateActionNames with a non-simple context, never in contextRequests (which is only for provider/history reads): the planner can read authorized descriptions with names=[] and load schemas by exact name. No catalog is preloaded here; its absence does not imply missing capability. Hints and discovery never establish execution or permission. A conversational reply needs no discovery."
					: args.includeActionDiscovery === "index" &&
							index.length < fullCatalog.length
						? index
						: fullCatalog,
			},
		});
	}

	const replyReferenceEvent = replyReferenceEventForContext(args.message);
	if (replyReferenceEvent) {
		events.push(replyReferenceEvent);
	}

	events.push({
		id: String(args.message.id ?? "current-message"),
		type: "message",
		source: args.message.content.source ?? "user",
		createdAt: args.message.createdAt,
		message: {
			id: args.message.id,
			role: "user",
			content: currentMessageContentForContext(args.message),
			metadata: {
				roomId: args.message.roomId,
				entityId: args.message.entityId,
			},
		},
	});

	if (args.includeTools && args.selectedContexts?.length) {
		const actions =
			args.preselectedActions ??
			(await collectV5PlannerCandidateActions({
				runtime: args.runtime,
				message: args.message,
				state: args.state,
				selectedContexts: args.selectedContexts,
				userRoles: args.userRoles,
			}));
		const displayActions = args.actionSurface
			? actions.filter((action) =>
					args.actionSurface?.exposedActionNames.has(
						normalizeActionIdentifier(action.name),
					),
				)
			: actions;
		for (const action of displayActions) {
			const tool = actionToTool(action);
			events.push({
				id: `tool:${tool.function.name}`,
				type: "tool",
				source: "message-service",
				tool: {
					name: tool.function.name,
					description: tool.function.description,
					parameters: tool.function.parameters,
					action,
				},
			});
		}
	}

	const systemPrompt = buildCanonicalSystemPrompt({
		character: args.runtime.character,
		userRole: args.userRoles?.[0],
	});
	// Chat style directions (style.all + style.chat) render exactly once here,
	// in the stable prefix. Computed statically from the character — not via the
	// per-room CHARACTER provider — so the KV-cacheable prefix stays
	// byte-identical across turns (#17026).
	const characterStyleDirections = buildCharacterStyleDirections({
		character: args.runtime.character,
	});
	// Stage 2 exposes each Action as its own native tool. Per-action specs live
	// in `events[type=tool]`; the LLM calls each action directly by name. We
	// also expose the universal terminal-sentinel tools (REPLY / IGNORE / STOP)
	// so the planner has a stable way to end the turn regardless of narrowing.
	// Empty when no actions are gated so the planner can short-circuit.
	const hasAnyAction = events.some(
		(event) =>
			event.type === "tool" &&
			"tool" in event &&
			Boolean(
				(event as { tool?: { name?: string } }).tool?.name?.trim().length,
			),
	);
	const expandedTools: ToolDefinition[] = hasAnyAction
		? [...CORE_PLANNER_TERMINALS]
		: [];
	return createContextObject({
		id: String(args.message.id ?? v4()),
		createdAt: Date.now(),
		metadata: {
			roomId: args.message.roomId,
			messageId: args.message.id,
			selectedContexts: [...(args.selectedContexts ?? [])],
			...(args.actionSurface
				? { actionSurface: args.actionSurface.summary as JsonValue }
				: {}),
		},
		staticPrefix: {
			systemPrompt: systemPrompt
				? {
						id: "system",
						label: "system",
						content: systemPrompt,
						stable: true,
					}
				: undefined,
			characterPrompt: characterStyleDirections
				? {
						id: "character-style",
						label: "system",
						content: characterStyleDirections,
						stable: true,
					}
				: undefined,
		},
		trajectoryPrefix: {
			selectedContexts: [...(args.selectedContexts ?? [])],
			contextDefinitions:
				args.selectedContexts && args.availableContexts
					? args.availableContexts.filter((def) =>
							args.selectedContexts?.includes(def.id),
						)
					: [],
			expandedTools,
			createdAtStageId: "message-handler",
		},
		plannedQueue: [],
		metrics: {},
		limits: {},
		events,
	});
}
