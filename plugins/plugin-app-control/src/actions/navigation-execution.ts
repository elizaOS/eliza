/**
 * Carries trusted navigation policy through the canonical turn execution scope.
 * Tool arguments cannot relax this actor/turn-bound constraint or cancellation.
 */
import type { Memory } from "@elizaos/core";
import {
	getStreamingContext,
	getTurnActionConstraint,
	setTurnActionConstraint,
} from "@elizaos/core";

export type NavigationReceipt = {
	effect: "view_navigation";
	stepId: string | null;
	viewId: string | null;
	status:
		| "invalid"
		| "forbidden"
		| "cancelled"
		| "unavailable"
		| "not-found"
		| "ambiguous"
		| "accepted"
		| "delivered"
		| "not-delivered"
		| "malformed"
		| "unsupported-route"
		| "http-error"
		| "transport-error";
	reason?: string;
	handoffId?: string;
	label?: string;
	subview?: string;
	path?: string;
};

export function setNavigationConstraint(
	message: Memory,
	disposition: "allow" | "deny",
	reason: string,
): void {
	setTurnActionConstraint({
		messageId: message.id ?? "",
		roomId: message.roomId,
		actorId: message.entityId,
		action: "VIEWS",
		operations: ["show", "open"],
		disposition,
		reason,
	});
}

export function navigationDispatchBlock(
	message: Memory,
	plannerStep: boolean,
): "cancelled" | "forbidden" | "invalid" | undefined {
	if (getStreamingContext()?.abortSignal?.aborted) return "cancelled";
	const constraint = getTurnActionConstraint(
		{
			messageId: message.id ?? "",
			roomId: message.roomId,
			actorId: message.entityId,
			action: "VIEWS",
		},
		"show",
	);
	if (
		!constraint &&
		[...(getStreamingContext()?.actionConstraints?.values() ?? [])].some(
			(item) => item.action === "VIEWS",
		)
	)
		return "invalid";
	if (constraint?.disposition === "deny") return "forbidden";
	if (plannerStep && constraint?.disposition !== "allow") return "invalid";
	return undefined;
}

/** Combine the transport deadline with the canonical cancellation signal. */
export function navigationRequestSignal(timeoutMs: number): AbortSignal {
	const signal = getStreamingContext()?.abortSignal;
	return signal
		? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);
}
