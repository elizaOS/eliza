/** Defines the immutable message pipeline request and its delivery, cancellation, and observation callbacks. */

import type { PlannerLoopParams } from "../../runtime/planner-loop";
import type { RoomHandlerLease } from "../../runtime/room-handler-queue";
import type { CodingActionProfile } from "../../types/coding";
import type { ActionResult, HandlerCallback } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import type {
	ResponseHandlerEarlyReplyEvent,
	Stage1DecisionObservation,
} from "./contracts.js";
import type { MessageRunTerminalOwner } from "./turn-session.js";

export type V5MessageRuntimeInput = {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	responseId: UUID;
	/** Trusted per-turn direct coding-loop selection. */
	codingMode?: boolean;
	/** Optional model-facing action policy for this trusted coding turn. */
	codingActionProfile?: CodingActionProfile;
	callback?: HandlerCallback;
	deliveredVisibleTexts?: Set<string>;
	plannerLoopConfig?: PlannerLoopParams["config"];
	onSettledActionResult?: (result: ActionResult) => void;
	roomHandlerLease?: RoomHandlerLease;
	runTerminalOwner?: MessageRunTerminalOwner;
	/**
	 * Optional pre-planner early-reply delivery seam. A consumer that decides
	 * NOT to deliver the event (e.g. the voice fast path's async-handoff gate)
	 * must return `false` so the producer's `earlyReplySent` bookkeeping —
	 * dedupe, preserved-answer rescue, planner-state refresh — reflects what
	 * the user actually saw. Any other return value counts as delivered.
	 */
	onResponseHandlerEarlyReply?: (
		event: ResponseHandlerEarlyReplyEvent,
	) => Promise<boolean> | Promise<void> | boolean | undefined;
	/**
	 * Fires once Stage 1 routing commits this turn to a response (final reply
	 * or planning). Lets the caller distinguish "runtime died after the model
	 * chose to answer" from "died before any respond decision existed" in its
	 * failure-reply gate.
	 */
	onStage1RespondDecision?: () => void;
	/** Receives the exact parsed Stage-1 decision and its inference provenance. */
	onStage1Decision?: (observation: Stage1DecisionObservation) => void;
	/** Stops after Stage-1 routing, before reply generation, planning, or tools. */
	stage1DecisionOnly?: boolean;
};
