/** Executes registered shortcut gates and settles their visible reply and interaction events. */

import { hasAtLeastRole, isAdminRank } from "../../roles";
import {
	executePlannedToolCall,
	projectActionResultForClipboard,
	shouldSuppressActionResultClipboard,
} from "../../runtime/execute-planned-tool-call";
import { SIMPLE_CONTEXT_ID } from "../../runtime/message-handler";
import type { PlannerToolCall } from "../../runtime/planner-loop";
import type { ShortcutRegistry } from "../../runtime/shortcut-registry";
import type { ActionResult } from "../../types/components";
import type { RoleGateRole } from "../../types/contexts";
import { EventType } from "../../types/events";
import type { Memory } from "../../types/memory";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { ShortcutMatch } from "../../types/shortcut";
import type { State } from "../../types/state";
import { getUserMessageText } from "../../utils/message-text";
import type { V5MessageRuntimeStage1Result } from "./contracts.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import {
	announceDirectToolCallToStream,
	settleFailedDirectToolCallOnStream,
} from "./planned-tool.js";
import { createV5ReplyStrategyResult } from "./reply-policy.js";
import { withActionResultsForPrompt } from "./response-state.js";
import type { MessageRunTerminalOwner } from "./turn-session.js";

/**
 * Pre-LLM action shortcut gate (#8791).
 *
 * Matches explicit slash/`!` protocol invocations against the runtime's
 * `ShortcutRegistry` before any model call. Ordinary language is deliberately
 * ineligible here: it must reach the planner even when a plugin registered a
 * natural-language shortcut. On an explicit `action`-target match the action
 * runs and its reply is returned as a `direct_reply` — emitting zero
 * `RESPONSE_HANDLER` tokens. Navigate/client targets are resolved on the client
 * (the slash menu already runs them locally) so the gate ignores them.
 *
 * Returns `null` on no match / mis-fire so the turn proceeds unchanged
 * (byte-identical to today). Set `ELIZA_SHORTCUTS_DISABLED=1` to bypass entirely.
 */
export async function runShortcutGate(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	senderRole: RoleGateRole;
	onSettledActionResult?: (result: ActionResult) => void;
	runTerminalOwner?: MessageRunTerminalOwner;
}): Promise<V5MessageRuntimeStage1Result | null> {
	if (process.env.ELIZA_SHORTCUTS_DISABLED === "1") return null;
	const text = getUserMessageText(args.message) ?? "";
	if (!text.trim()) return null;

	const registry = (args.runtime as { shortcutRegistry?: ShortcutRegistry })
		.shortcutRegistry;
	if (!registry || registry.size === 0) return null;

	const authorized = isAdminRank(args.senderRole);
	const match = registry.match(text, {
		actions: args.runtime.actions.map((action) => action.name),
		allowNatural: false,
		isAuthorized: authorized,
		isElevated: hasAtLeastRole(args.senderRole, "OWNER"),
	});
	if (!match) return null;
	const target = match.shortcut.target;
	// Navigate/client targets are resolved on the client (the slash menu runs
	// them locally with no agent round-trip), so the agent gate only fires actions.
	if (target.kind !== "action") return null;

	const action = args.runtime.actions.find((a) => a.name === target.name);
	if (!action) return null;

	let captured: string | undefined;
	const shortcutToolCall: PlannerToolCall = {
		id: `shortcut:${normalizeActionIdentifier(action.name)}`,
		name: action.name,
		params: { ...target.parameters, ...match.parameters },
	};
	await announceDirectToolCallToStream(args.runtime, shortcutToolCall);
	// Shortcuts enter the same executor as planner-selected tools so component
	// gates, argument validation, callback buffering, audience revalidation, and
	// action events remain one non-bypassable contract.
	let shortcutActionResult: ActionResult;
	try {
		shortcutActionResult = await executePlannedToolCall(
			args.runtime,
			{
				message: args.message,
				state: args.state,
				userRoles: [args.senderRole],
				activeContexts: ["general"],
				callback: async (content) => {
					if (typeof content?.text === "string" && content.text) {
						captured = content.text;
					}
					return [];
				},
			},
			shortcutToolCall,
			{
				actions: [action],
				...(args.onSettledActionResult
					? { onSettledResult: args.onSettledActionResult }
					: {}),
			},
		);
	} catch (error) {
		await settleFailedDirectToolCallOnStream(
			args.runtime,
			shortcutToolCall,
			error,
		);
		throw error;
	}
	if (captured === undefined) {
		const executionError = shortcutActionResult.data?.error;
		if (executionError !== undefined) {
			// A shortcut failure does not enter the planner transcript, so its
			// underlying exception needs a separate observable boundary.
			args.runtime.logger.warn(
				{
					src: "shortcut-gate",
					shortcut: match.shortcut.id,
					action: action.name,
					err: executionError,
				},
				"Shortcut action failed before producing a reply",
			);
		}
		return null;
	}
	let actionResult: ActionResult | undefined;
	if (shouldSuppressActionResultClipboard(action, shortcutActionResult)) {
		actionResult = projectActionResultForClipboard(
			action,
			shortcutActionResult,
			action.name,
		);
	} else {
		actionResult = {
			...shortcutActionResult,
			data: {
				...shortcutActionResult.data,
				actionName: action.name,
			},
		};
	}
	const resultState = actionResult
		? withActionResultsForPrompt(args.state, [actionResult], args.runtime)
		: args.state;
	const shortcutActionResults = actionResult ? [actionResult] : [];
	const { text: shortcutReply, effectReceiptIds: shortcutReplyReceiptIds } =
		await resolvePlannedReplyEgress({
			runtime: args.runtime,
			message: args.message,
			reply: captured,
			actionResults: shortcutActionResults,
		});

	// #8792: report the interaction so the proactive-comment decider can react.
	const interactionEvent = emitInteractionEvent(
		args.runtime,
		match,
		args.message,
	);
	if (args.runTerminalOwner) {
		args.runTerminalOwner.adopt("shortcut-interaction-event", interactionEvent);
	} else {
		void interactionEvent;
	}

	const thought = `Shortcut: ${match.shortcut.id}`;
	return {
		kind: "direct_reply",
		messageHandler: {
			processMessage: "RESPOND",
			thought,
			plan: {
				contexts: [SIMPLE_CONTEXT_ID],
				reply: shortcutReply,
				simple: true,
				requiresTool: false,
			},
		},
		result: {
			...createV5ReplyStrategyResult({
				runtime: args.runtime,
				message: args.message,
				state: resultState,
				responseId: args.responseId,
				text: shortcutReply,
				thought,
				...(shortcutReplyReceiptIds.length > 0
					? { effectReceiptIds: shortcutReplyReceiptIds }
					: {}),
			}),
			...(actionResult ? { actionResults: [actionResult] } : {}),
		},
	};
}

/** Emit SLASH_COMMAND_INVOKED / SHORTCUT_FIRED for a gated interaction (#8792). */
export async function emitInteractionEvent(
	runtime: IAgentRuntime,
	match: ShortcutMatch,
	message: Memory,
): Promise<void> {
	try {
		const roomId = message.roomId;
		if (match.shortcut.kind === "explicit") {
			const command = (match.shortcut.aliases?.[0] ?? match.shortcut.id)
				.replace(/^[/!]/, "")
				.trim();
			await runtime.emitEvent(EventType.SLASH_COMMAND_INVOKED, {
				runtime,
				source: "shortcut-gate",
				command,
				targetKind: "agent",
				initiatedBy: "user",
				roomId,
			});
		} else {
			await runtime.emitEvent(EventType.SHORTCUT_FIRED, {
				runtime,
				source: "shortcut-gate",
				shortcutId: match.shortcut.id,
				initiatedBy: "user",
				roomId,
			});
		}
	} catch (err) {
		// error-policy:J7 Interaction telemetry must not block the message turn.
		runtime.logger?.debug?.(
			{ src: "shortcut-gate", err },
			"interaction event emit failed",
		);
		runtime.reportError("MessageService.shortcutEvent", err, {
			shortcutId: match.shortcut.id,
			roomId: message.roomId,
		});
	}
}

import { resolvePlannedReplyEgress } from "./egress-policy.js";
