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
}

export type SwarmEventListener = (event: SwarmEvent) => void;

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
