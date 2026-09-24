/**
 * Multi-agent swarm-coordination types: the coordinator service token, bind-state
 * machine, and swarm event/listener and chat-routing shapes used to route a chat
 * session across a coordinated group of agents.
 */
export const SWARM_COORDINATOR_SERVICE_TYPE = "SWARM_COORDINATOR";

export interface SwarmCoordinatorBindState {
	status: "pending" | "bound" | "unbound";
	reason: string | null;
	attempts: number;
}

export interface SwarmEvent {
	type: string;
	sessionId: string;
	timestamp: number;
	data: unknown;
	/**
	 * Monotonic per-coordinator sequence number. The wire is not order-preserving
	 * (ACP fans events out synchronously, the WS layer batches), so the inline
	 * chat pipeline orders a session's steps by `seq`, not arrival order.
	 */
	seq?: number;
	/**
	 * The owning task thread. All sub-agent sessions of one task carry the same
	 * `taskId` so the client can group a flat event stream back into the
	 * task→sub-agent→step tree the inline pipeline renders. Absent for events
	 * that belong to no task (rare; treated as their own single-session group).
	 */
	taskId?: string;
	/**
	 * When a sub-agent spawns a nested child session, the child's events carry
	 * the parent session id so the pipeline can indent them under it.
	 */
	parentSessionId?: string;
}

export type SwarmEventListener = (event: SwarmEvent) => void;

/**
 * The typed, discriminated per-event contract the chat client consumes.
 *
 * `SwarmEvent.data` is `unknown` on the wire because it is assembled from
 * ACP-adapter payloads whose exact shape varies by backend. `toSwarmActivity`
 * is the single boundary that validates one raw event and narrows it to one of
 * these variants (or `null` when the event is not renderable inline) — so every
 * inline widget reads a typed envelope, never pokes at `data` itself. This is
 * the "validate at the boundary, type the result" rule applied to the wire.
 */
export type SwarmActivityKind =
	| "message"
	| "reasoning"
	| "plan"
	| "tool"
	| "lifecycle";

/** Coarse status the inline pipeline colors a step/agent by. */
export type SwarmActivityStatus =
	| "running"
	| "success"
	| "failure"
	| "waiting"
	| "idle";

/** One entry of a live plan/checklist (`plan` / todowrite). */
export interface SwarmActivityPlanEntry {
	content: string;
	status: "pending" | "in_progress" | "completed" | string;
	priority?: string;
}

/** A single tool call as surfaced to the inline step row. */
export interface SwarmActivityTool {
	id?: string;
	title?: string;
	kind?: string;
	status: SwarmActivityStatus;
	rawInput?: Record<string, unknown>;
	output?: string;
	locations?: Array<{ path?: string; line?: number }>;
}

interface SwarmActivityBase {
	sessionId: string;
	taskId?: string;
	parentSessionId?: string;
	seq: number;
	timestamp: number;
}

export interface SwarmActivityMessage extends SwarmActivityBase {
	kind: "message";
	text: string;
}
export interface SwarmActivityReasoning extends SwarmActivityBase {
	kind: "reasoning";
	text: string;
}
export interface SwarmActivityPlan extends SwarmActivityBase {
	kind: "plan";
	entries: SwarmActivityPlanEntry[];
}
export interface SwarmActivityToolStep extends SwarmActivityBase {
	kind: "tool";
	tool: SwarmActivityTool;
}
export interface SwarmActivityLifecycle extends SwarmActivityBase {
	kind: "lifecycle";
	/** The raw ACP event name (`ready` | `task_complete` | `stopped` | …). */
	event: string;
	status: SwarmActivityStatus;
	label?: string;
	text?: string;
}

export type SwarmActivityEnvelope =
	| SwarmActivityMessage
	| SwarmActivityReasoning
	| SwarmActivityPlan
	| SwarmActivityToolStep
	| SwarmActivityLifecycle;

export interface SwarmCoordinatorChatRouting {
	sessionId?: string;
	threadId?: string;
	roomId?: string | null;
}

export type SwarmCoordinatorChatCallback = (
	text: string,
	source?: string,
	routing?: SwarmCoordinatorChatRouting,
) => Promise<void>;

export type SwarmCoordinatorWsBroadcastCallback = (event: SwarmEvent) => void;

export interface SwarmCoordinatorTaskContext {
	threadId?: string | null;
	taskNodeId?: string;
	sessionId?: string;
	agentType?: string;
	label?: string;
	originalTask?: string;
	workdir?: string;
	repo?: string;
	originRoomId?: string;
	originMetadata?: Record<string, unknown>;
	status?: string;
	decisions?: unknown[];
	autoResolvedCount?: number;
	registeredAt?: number;
	lastActivityAt?: number;
	idleCheckCount?: number;
	taskDelivered?: boolean;
	completionSummary?: string;
	validationSummary?: string;
	lastSeenDecisionIndex?: number;
	lastInputSentAt?: number;
	stoppedAt?: number;
	[key: string]: unknown;
}

export type SwarmCoordinatorAgentDecisionCallback = (
	eventDescription: string,
	sessionId: string,
	taskContext: SwarmCoordinatorTaskContext,
) => Promise<unknown | null>;

export interface SwarmCoordinatorTaskCompletionSummary {
	sessionId: string;
	label: string;
	agentType: string;
	originalTask: string;
	status: string;
	completionSummary: string;
	validationSummary?: string;
	workdir?: string;
	roomId?: string | null;
	replyToExternalMessageId?: string | null;
	[key: string]: unknown;
}

export interface SwarmCoordinatorCompletionPayload {
	tasks: SwarmCoordinatorTaskCompletionSummary[];
	total: number;
	completed: number;
	stopped: number;
	errored: number;
}

export type SwarmCoordinatorCompleteCallback = (
	payload: SwarmCoordinatorCompletionPayload,
) => Promise<void>;

export interface ISwarmCoordinatorService {
	subscribe(listener: SwarmEventListener): () => void;
	setChatCallback(cb: SwarmCoordinatorChatCallback): void;
	setWsBroadcast(cb: SwarmCoordinatorWsBroadcastCallback): void;
	setAgentDecisionCallback(cb: SwarmCoordinatorAgentDecisionCallback): void;
	setSwarmCompleteCallback(cb: SwarmCoordinatorCompleteCallback): void;
	getTaskContext?(
		sessionId: string,
	): SwarmCoordinatorTaskContext | null | undefined;
	getAllTaskContexts?(): SwarmCoordinatorTaskContext[];
	getTaskThread?(threadId: string): Promise<{ roomId?: string | null } | null>;
	sourceRoomId?: string | null;
	acpBindState?: SwarmCoordinatorBindState;
}

export interface SwarmCoordinatorRuntime {
	getService(serviceType: string): unknown;
}

export function getSwarmCoordinatorService(
	runtime: SwarmCoordinatorRuntime | null | undefined,
): ISwarmCoordinatorService | null {
	if (!runtime) return null;
	return (
		(runtime.getService(
			SWARM_COORDINATOR_SERVICE_TYPE,
		) as ISwarmCoordinatorService | null) ?? null
	);
}
