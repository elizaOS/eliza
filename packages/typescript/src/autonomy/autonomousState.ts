import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
	UUID,
} from "../types";

interface AgentEventPayloadLike {
	runId: string;
	seq: number;
	stream: string;
	ts: number;
	data: Record<string, unknown>;
	sessionKey?: string;
	agentId?: string;
	roomId?: UUID;
}

interface HeartbeatEventPayloadLike {
	ts: number;
	status: string;
	to?: string;
	preview?: string;
	durationMs?: number;
	hasMedia?: boolean;
	reason?: string;
	channel?: string;
	silent?: boolean;
	indicatorType?: string;
}

interface AgentEventServiceLike {
	subscribe: (listener: (event: AgentEventPayloadLike) => void) => () => void;
	subscribeHeartbeat?: (
		listener: (event: HeartbeatEventPayloadLike) => void,
	) => () => void;
	getLastHeartbeat?: () => HeartbeatEventPayloadLike | null;
}

interface AutonomousEventCacheState {
	runtime: IAgentRuntime;
	events: AgentEventPayloadLike[];
	detach: () => void;
}

const MAX_CACHED_EVENTS = 240;
const cacheByAgentId = new Map<string, AutonomousEventCacheState>();
const lastHeartbeatByAgentId = new Map<string, HeartbeatEventPayloadLike>();

function getRuntimeAgentId(runtime: IAgentRuntime): string {
	return String(runtime.agentId);
}

async function getAgentEventService(
	runtime: IAgentRuntime,
): Promise<AgentEventServiceLike | null> {
	return runtime.getService("AGENT_EVENT") as AgentEventServiceLike | null;
}

function pushCachedEvent(agentId: string, event: AgentEventPayloadLike): void {
	const state = cacheByAgentId.get(agentId);
	if (!state) return;
	state.events.push(event);
	if (state.events.length > MAX_CACHED_EVENTS) {
		state.events.splice(0, state.events.length - MAX_CACHED_EVENTS);
	}
}

export async function ensureAutonomousStateTracking(
	runtime: IAgentRuntime,
): Promise<void> {
	const agentId = getRuntimeAgentId(runtime);
	const existing = cacheByAgentId.get(agentId);
	if (existing && existing.runtime === runtime) {
		return;
	}
	if (existing) {
		existing.detach();
		cacheByAgentId.delete(agentId);
		lastHeartbeatByAgentId.delete(agentId);
	}

	const service = await getAgentEventService(runtime);
	if (!service) return;

	const events: AgentEventPayloadLike[] = [];
	const unsubscribeEvents = service.subscribe((event) => {
		if (event.agentId && event.agentId !== agentId) {
			return;
		}
		pushCachedEvent(agentId, event);
	});

	const unsubscribeHeartbeat = service.subscribeHeartbeat?.((heartbeat) => {
		lastHeartbeatByAgentId.set(agentId, heartbeat);
	});

	const lastHeartbeat = service.getLastHeartbeat?.();
	if (lastHeartbeat) {
		lastHeartbeatByAgentId.set(agentId, lastHeartbeat);
	}

	cacheByAgentId.set(agentId, {
		runtime,
		events,
		detach: () => {
			unsubscribeEvents();
			if (unsubscribeHeartbeat) unsubscribeHeartbeat();
		},
	});
}

export function __resetAutonomousStateTrackingForTests(): void {
	for (const state of cacheByAgentId.values()) {
		state.detach();
	}
	cacheByAgentId.clear();
	lastHeartbeatByAgentId.clear();
}

function renderEventLine(event: AgentEventPayloadLike): string {
	const textValue = event.data.text;
	const previewValue = event.data.preview;
	const text = typeof textValue === "string" ? textValue.trim() : "";
	const preview = typeof previewValue === "string" ? previewValue.trim() : "";
	const body = text || preview || `${event.stream} event`;
	return `- [${event.stream}] ${body}`;
}

function renderHeartbeatLine(heartbeat: HeartbeatEventPayloadLike): string {
	const target =
		typeof heartbeat.to === "string" && heartbeat.to.trim()
			? ` to ${heartbeat.to.trim()}`
			: "";
	const preview =
		typeof heartbeat.preview === "string" && heartbeat.preview.trim()
			? ` — ${heartbeat.preview.trim()}`
			: "";
	return `- [heartbeat/${heartbeat.status}]${target}${preview}`;
}

export function createAutonomousStateProvider(): Provider {
	return {
		name: "elizaAutonomousState",
		description:
			"Recent autonomous loop activity (thoughts/actions/heartbeat) for context bridging.",
		get: async (
			runtime: IAgentRuntime,
			_message: Memory,
			_state: State,
		): Promise<ProviderResult> => {
			await ensureAutonomousStateTracking(runtime);
			const agentId = getRuntimeAgentId(runtime);
			const recent = cacheByAgentId.get(agentId)?.events.slice(-24) ?? [];
			const activityLines = recent
				.filter(
					(event) =>
						event.stream === "assistant" ||
						event.stream === "action" ||
						event.stream === "tool",
				)
				.slice(-10)
				.map(renderEventLine);

			const service = await getAgentEventService(runtime);
			const heartbeat =
				lastHeartbeatByAgentId.get(agentId) ??
				service?.getLastHeartbeat?.() ??
				null;

			const renderedLines = [...activityLines];
			if (heartbeat) {
				renderedLines.push(renderHeartbeatLine(heartbeat));
			}

			const text =
				renderedLines.length > 0
					? `Autonomous state snapshot:\n${renderedLines.join("\n")}`
					: "Autonomous state snapshot: no recent thought/action events.";

			return {
				text,
				values: {
					hasAutonomousState: renderedLines.length > 0,
					autonomousEventsCount: recent.length,
					heartbeatStatus: heartbeat?.status ?? "",
				},
				data: {
					events: recent.slice(-10).map((event) => ({
						runId: event.runId,
						seq: event.seq,
						stream: event.stream,
						ts: event.ts,
					})),
					heartbeat: heartbeat
						? {
								status: heartbeat.status,
								ts: heartbeat.ts,
								to: heartbeat.to ?? "",
							}
						: null,
				},
			};
		},
	};
}
