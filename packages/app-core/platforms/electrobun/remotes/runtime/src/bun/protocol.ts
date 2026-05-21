export const RUNTIME_REMOTE_ID = "eliza.runtime" as const;
export const SURFACE_REMOTE_ID = "eliza.surface" as const;
export const FILE_REMOTE_ID = "eliza.fs" as const;
export const TERMINAL_REMOTE_ID = "eliza.pty" as const;
export const GIT_REMOTE_ID = "eliza.git" as const;
export const MODEL_REMOTE_ID = "eliza.local-model" as const;

export type RuntimeMode =
	| "stopped"
	| "starting"
	| "running"
	| "stopping"
	| "error";

export type RuntimeState = {
	mode: RuntimeMode;
	cwd: string;
	command: string[];
	apiBase: string | null;
	pid: number | null;
	startedAt: string | null;
	stoppedAt: string | null;
	error: string | null;
};

export type RuntimeMethod =
	| "runtime.start"
	| "runtime.stop"
	| "runtime.restart"
	| "runtime.status"
	| "runtime.health"
	| "runtime.logs.tail"
	| "api.discover"
	| "api.status"
	| "agent.list"
	| "agent.get"
	| "agent.message"
	| "conversation.list"
	| "conversation.get"
	| "plugin.list"
	| "memory.search"
	| "config.get"
	| "agent.message.stream"
	| "agent.message.stream.cancel"
	| "agent.message.stream.status"
	| "fs.status"
	| "fs.roots"
	| "fs.stat"
	| "fs.list"
	| "fs.readText"
	| "fs.search"
	| "fs.writeText"
	| "pty.status"
	| "pty.session.create"
	| "pty.session.list"
	| "pty.session.get"
	| "pty.session.write"
	| "pty.session.resize"
	| "pty.session.kill"
	| "pty.session.output.tail"
	| "pty.session.output.clear"
	| "pty.command.run"
	| "git.status"
	| "git.repo.info"
	| "git.branches"
	| "git.remotes"
	| "git.log"
	| "git.diff"
	| "git.show"
	| "git.add"
	| "git.restore"
	| "git.checkout"
	| "git.branch.create"
	| "git.branch.delete"
	| "git.commit"
	| "git.fetch"
	| "git.pull"
	| "git.push"
	| "git.operation.list"
	| "git.operation.get"
	| "git.command.run"
	| "model.status"
	| "model.hub"
	| "model.catalog"
	| "model.catalog.eliza1"
	| "model.eliza1.tiers"
	| "model.eliza1.voice"
	| "model.hf.metadata"
	| "model.providers"
	| "model.hardware"
	| "model.installed"
	| "model.download.start"
	| "model.download.cancel"
	| "model.downloads"
	| "model.active"
	| "model.activate"
	| "model.unload"
	| "model.assignments"
	| "model.assignment.set"
	| "model.routing"
	| "model.routing.set"
	| "model.routing.useLocal"
	| "model.routing.useCloud"
	| "model.generate"
	| "model.embedding"
	| "model.capabilities";

export type RuntimeEventName =
	| "runtime.statusChanged"
	| "runtime.log"
	| "runtime.error"
	| "runtime.started"
	| "runtime.stopped"
	| "agent.message.stream.started"
	| "agent.message.stream.delta"
	| "agent.message.stream.snapshot"
	| "agent.message.stream.action"
	| "agent.message.stream.error"
	| "agent.message.stream.done"
	| "agent.message.stream.cancelled";

export type RuntimeLogStream = "stdout" | "stderr" | "system";

export type RuntimeLogEntry = {
	timestamp: string;
	stream: RuntimeLogStream;
	line: string;
};

export type RuntimeStartParams = {
	cwd?: string;
	command?: string[] | string;
	apiBase?: string;
};

export type RuntimeHealthAttempt = {
	path: string;
	ok: boolean;
	status: number | null;
	elapsedMs: number;
	error: string | null;
};

export type RuntimeHealthResult =
	| {
			ok: true;
			apiBase: string;
			path: string;
			status: number;
			elapsedMs: number;
			body: string;
			attempts: RuntimeHealthAttempt[];
	  }
	| {
			ok: false;
			apiBase: string;
			path: null;
			status: null;
			elapsedMs: number;
			error: string;
			attempts: RuntimeHealthAttempt[];
	  };

export type ApiRouteStatusMethod = "GET" | "POST" | "OPTIONS";

export type ApiRouteStatus = {
	name: string;
	method: ApiRouteStatusMethod;
	path: string;
	available: boolean;
	status?: number;
	error?: string;
};

export type ApiDiscoveryResult = {
	apiBase: string;
	routes: ApiRouteStatus[];
	streamingRoutes: StreamingRouteStatus[];
};

export type AgentSummary = {
	id: string;
	name?: string;
	status?: string;
	metadata?: Record<string, unknown>;
};

export type ConversationSummary = {
	id: string;
	title?: string;
	agentId?: string;
	updatedAt?: string;
	metadata?: Record<string, unknown>;
};

export type AgentMessageParams = {
	agentId?: string;
	conversationId?: string;
	text: string;
	attachments?: Array<{
		type: "file" | "image" | "audio";
		path?: string;
		url?: string;
		mimeType?: string;
	}>;
};

export type AgentMessageResult = {
	ok: boolean;
	conversationId?: string;
	messageId?: string;
	text?: string;
	raw?: unknown;
};

export type StreamId = string;

export type AgentMessageStreamParams = {
	agentId?: string;
	conversationId?: string;
	text: string;
	attachments?: Array<{
		type: "file" | "image" | "audio";
		path?: string;
		url?: string;
		mimeType?: string;
	}>;
	metadata?: Record<string, unknown>;
};

export type AgentMessageStreamStartResult = {
	ok: boolean;
	streamId: StreamId;
	conversationId?: string;
	messageId?: string;
};

export type AgentMessageStreamStatus = {
	streamId: StreamId;
	active: boolean;
	startedAt: string;
	completedAt?: string;
	cancelledAt?: string;
	error?: string;
};

export type AgentMessageStreamCancelParams = {
	streamId: StreamId;
};

export type StreamEventKind =
	| "started"
	| "delta"
	| "snapshot"
	| "action"
	| "error"
	| "done"
	| "cancelled";

export type AgentMessageStreamEvent = {
	streamId: StreamId;
	kind: StreamEventKind;
	conversationId?: string;
	messageId?: string;
	delta?: string;
	text?: string;
	actionName?: string;
	toolName?: string;
	payload?: unknown;
	raw?: unknown;
	timestamp: string;
};

export type StreamingRouteStatus = {
	name: string;
	method: "GET" | "POST";
	path: string;
	available: boolean;
	status?: number;
	error?: string;
};

export type ApiBridgeError = {
	code:
		| "RUNTIME_NOT_RUNNING"
		| "API_BASE_MISSING"
		| "ROUTE_UNAVAILABLE"
		| "REQUEST_FAILED"
		| "DECODE_FAILED"
		| "CAPABILITY_UNAVAILABLE"
		| "UNKNOWN";
	message: string;
	method?: string;
	path?: string;
	status?: number;
	details?: unknown;
};

export type RuntimeEventPayload =
	| RuntimeState
	| RuntimeLogEntry
	| RuntimeHealthResult
	| AgentMessageStreamEvent
	| { message: string; state: RuntimeState };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| { [key: string]: JsonValue }
	| JsonValue[];

export type RuntimeWorkerRequestMessage = {
	type: "request";
	requestId: string | number;
	method: RuntimeMethod;
	params?: JsonValue;
};

export type RuntimeResponsePayload =
	| RuntimeState
	| RuntimeHealthResult
	| RuntimeLogEntry[]
	| ApiDiscoveryResult
	| AgentSummary[]
	| ConversationSummary[]
	| AgentMessageResult
	| AgentMessageStreamStartResult
	| AgentMessageStreamStatus
	| null
	| unknown[]
	| unknown
	| { ok: true };

export type RuntimeWorkerResponseMessage =
	| {
			type: "response";
			requestId: string | number;
			success: true;
			payload: RuntimeResponsePayload;
	  }
	| {
			type: "response";
			requestId: string | number;
			success: false;
			error: ApiBridgeError;
	  };

export type RuntimeWorkerEventMessage = {
	type: "event";
	name: RuntimeEventName;
	payload: RuntimeEventPayload;
};

export type RuntimeWorkerReadyMessage = {
	type: "ready";
};

export type RuntimeWorkerOutboundMessage =
	| RuntimeWorkerResponseMessage
	| RuntimeWorkerEventMessage
	| RuntimeWorkerReadyMessage;

export type RuntimeManagerEvent = {
	name: RuntimeEventName;
	payload: RuntimeEventPayload;
};
