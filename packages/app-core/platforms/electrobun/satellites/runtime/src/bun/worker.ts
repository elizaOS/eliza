import { ElizaRuntimeApiClient } from "./api-client.ts";
import { createApiBridgeError, serializeError } from "./errors.ts";
import { RuntimeLogBuffer } from "./log-buffer.ts";
import type {
	AgentMessageParams,
	AgentMessageStreamCancelParams,
	AgentMessageStreamParams,
	JsonValue,
	RuntimeLogEntry,
	RuntimeManagerEvent,
	RuntimeMethod,
	RuntimeResponsePayload,
	RuntimeStartParams,
	RuntimeState,
	RuntimeWorkerOutboundMessage,
	RuntimeWorkerRequestMessage,
} from "./protocol.ts";
import {
	FILE_SATELLITE_ID,
	GIT_SATELLITE_ID,
	MODEL_SATELLITE_ID,
	TERMINAL_SATELLITE_ID,
} from "./protocol.ts";
import { ElizaRuntimeManager } from "./runtime-manager.ts";
import { AgentStreamManager } from "./stream-manager.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

type HostResponseMessage = {
	type: "host-response";
	requestId: number;
	success: boolean;
	payload?: JsonValue;
	error?: string;
};

type HostRequestMessage = {
	type: "host-request";
	requestId: number;
	method:
		| "invoke-carrot"
		| "agent-manager-start"
		| "agent-manager-stop"
		| "agent-manager-restart"
		| "agent-manager-status"
		| "agent-manager-health"
		| "agent-manager-logs-tail";
	params?: JsonValue;
};

type PendingHostRequest = {
	method: string;
	unavailableMessage: string;
	resolve: (payload: JsonValue | undefined) => void;
	reject: (error: unknown) => void;
};

const pendingHostRequests = new Map<number, PendingHostRequest>();
let nextHostRequestId = 1;
let hostRuntimeAdapterAvailable = false;
let hostRuntimeState: RuntimeState | null = null;

function post(message: RuntimeWorkerOutboundMessage): void {
	self.postMessage(message);
}

function postHost(message: HostRequestMessage): void {
	self.postMessage(message);
}

function isRuntimeMethod(value: string): value is RuntimeMethod {
	return (
		value === "runtime.start" ||
		value === "runtime.stop" ||
		value === "runtime.restart" ||
		value === "runtime.status" ||
		value === "runtime.health" ||
		value === "runtime.logs.tail" ||
		value === "api.discover" ||
		value === "api.status" ||
		value === "agent.list" ||
		value === "agent.get" ||
		value === "agent.message" ||
		value === "conversation.list" ||
		value === "conversation.get" ||
		value === "plugin.list" ||
		value === "memory.search" ||
		value === "config.get" ||
		value === "agent.message.stream" ||
		value === "agent.message.stream.cancel" ||
		value === "agent.message.stream.status" ||
		value === "fs.status" ||
		value === "fs.roots" ||
		value === "fs.stat" ||
		value === "fs.list" ||
		value === "fs.readText" ||
		value === "fs.search" ||
		value === "fs.writeText" ||
		value === "pty.status" ||
		value === "pty.session.create" ||
		value === "pty.session.list" ||
		value === "pty.session.get" ||
		value === "pty.session.write" ||
		value === "pty.session.resize" ||
		value === "pty.session.kill" ||
		value === "pty.session.output.tail" ||
		value === "pty.session.output.clear" ||
		value === "pty.command.run" ||
		value === "git.status" ||
		value === "git.repo.info" ||
		value === "git.branches" ||
		value === "git.remotes" ||
		value === "git.log" ||
		value === "git.diff" ||
		value === "git.show" ||
		value === "git.add" ||
		value === "git.restore" ||
		value === "git.checkout" ||
		value === "git.branch.create" ||
		value === "git.branch.delete" ||
		value === "git.commit" ||
		value === "git.fetch" ||
		value === "git.pull" ||
		value === "git.push" ||
		value === "git.operation.list" ||
		value === "git.operation.get" ||
		value === "git.command.run" ||
		value === "model.status" ||
		value === "model.hub" ||
		value === "model.catalog" ||
		value === "model.catalog.eliza1" ||
		value === "model.eliza1.tiers" ||
		value === "model.eliza1.voice" ||
		value === "model.hf.metadata" ||
		value === "model.providers" ||
		value === "model.hardware" ||
		value === "model.installed" ||
		value === "model.download.start" ||
		value === "model.download.cancel" ||
		value === "model.downloads" ||
		value === "model.active" ||
		value === "model.activate" ||
		value === "model.unload" ||
		value === "model.assignments" ||
		value === "model.assignment.set" ||
		value === "model.routing" ||
		value === "model.routing.set" ||
		value === "model.routing.useLocal" ||
		value === "model.routing.useCloud" ||
		value === "model.generate" ||
		value === "model.embedding" ||
		value === "model.capabilities"
	);
}

function isHostResponse(value: unknown): value is HostResponseMessage {
	if (!isRecord(value)) return false;
	return (
		value.type === "host-response" &&
		typeof value.requestId === "number" &&
		typeof value.success === "boolean"
	);
}

function isInitMessage(value: unknown): value is { type: "init" } {
	return isRecord(value) && value.type === "init";
}

function completeHostRequest(message: HostResponseMessage): void {
	const pending = pendingHostRequests.get(message.requestId);
	if (!pending) return;
	pendingHostRequests.delete(message.requestId);
	if (message.success) {
		pending.resolve(message.payload);
		return;
	}
	pending.reject(
		createApiBridgeError({
			code: "CAPABILITY_UNAVAILABLE",
			message: pending.unavailableMessage,
			method: pending.method,
			details: message.error ?? "Satellite request failed.",
		}),
	);
}

function parseRequest(value: unknown): RuntimeWorkerRequestMessage | null {
	if (!isRecord(value)) return null;
	if (value.type !== "request") return null;
	const requestId = value.requestId;
	const method = value.method;
	if (
		(typeof requestId !== "string" && typeof requestId !== "number") ||
		typeof method !== "string" ||
		!isRuntimeMethod(method)
	) {
		throw new Error("Invalid runtime request.");
	}
	const params = value.params;
	return params === undefined
		? { type: "request", requestId, method }
		: { type: "request", requestId, method, params: params as JsonValue };
}

function parseStartParams(params?: JsonValue): RuntimeStartParams | undefined {
	if (params === undefined) return undefined;
	if (!isRecord(params))
		throw new Error("runtime.start params must be an object.");
	const parsed: RuntimeStartParams = {};
	const cwd = params.cwd;
	const command = params.command;
	const apiBase = params.apiBase;
	if (cwd !== undefined) {
		if (typeof cwd !== "string" || cwd.length === 0) {
			throw new Error("runtime.start cwd must be a non-empty string.");
		}
		parsed.cwd = cwd;
	}
	if (apiBase !== undefined) {
		if (typeof apiBase !== "string" || apiBase.length === 0) {
			throw new Error("runtime.start apiBase must be a non-empty string.");
		}
		parsed.apiBase = apiBase;
	}
	if (command !== undefined) {
		if (typeof command === "string") {
			parsed.command = command;
		} else if (isStringArray(command)) {
			parsed.command = command;
		} else {
			throw new Error(
				"runtime.start command must be a string or string array.",
			);
		}
	}
	return parsed;
}

function isStringArray(value: JsonValue): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function stringParam(params: JsonValue | undefined, key: string): string {
	if (!isRecord(params)) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: `${key} is required.`,
		});
	}
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: `${key} must be a non-empty string.`,
		});
	}
	return value.trim();
}

function parseLogLimit(params?: JsonValue): number | undefined {
	if (params === undefined) return undefined;
	if (!isRecord(params))
		throw new Error("runtime.logs.tail params must be an object.");
	const limit = params.limit;
	if (limit === undefined) return undefined;
	if (typeof limit !== "number" || !Number.isFinite(limit)) {
		throw new Error("runtime.logs.tail limit must be a finite number.");
	}
	return limit;
}

function parseDiscoverRefresh(params?: JsonValue): boolean {
	if (params === undefined) return true;
	if (!isRecord(params)) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "api.discover params must be an object.",
		});
	}
	const refresh = params.refresh;
	if (refresh === undefined) return true;
	if (typeof refresh !== "boolean") {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "api.discover refresh must be a boolean.",
		});
	}
	return refresh;
}

function parseAgentMessageParams(params?: JsonValue): AgentMessageParams {
	if (!isRecord(params)) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "agent.message params must be an object.",
		});
	}
	const text = params.text;
	if (typeof text !== "string" || text.trim().length === 0) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "agent.message text must be a non-empty string.",
		});
	}
	const parsed: AgentMessageParams = { text };
	const agentId = params.agentId;
	const conversationId = params.conversationId;
	if (agentId !== undefined) {
		if (typeof agentId !== "string" || agentId.trim().length === 0) {
			throw createApiBridgeError({
				code: "DECODE_FAILED",
				message: "agent.message agentId must be a non-empty string.",
			});
		}
		parsed.agentId = agentId.trim();
	}
	if (conversationId !== undefined) {
		if (
			typeof conversationId !== "string" ||
			conversationId.trim().length === 0
		) {
			throw createApiBridgeError({
				code: "DECODE_FAILED",
				message: "agent.message conversationId must be a non-empty string.",
			});
		}
		parsed.conversationId = conversationId.trim();
	}
	if (Array.isArray(params.attachments)) {
		const attachments: NonNullable<AgentMessageParams["attachments"]> = [];
		for (const attachmentValue of params.attachments) {
			if (!isRecord(attachmentValue)) continue;
			const type = attachmentValue.type;
			if (type !== "file" && type !== "image" && type !== "audio") {
				throw createApiBridgeError({
					code: "DECODE_FAILED",
					message: "agent.message attachment type is invalid.",
				});
			}
			const path = attachmentValue.path;
			const url = attachmentValue.url;
			const mimeType = attachmentValue.mimeType;
			attachments.push({
				type,
				...(typeof path === "string" ? { path } : {}),
				...(typeof url === "string" ? { url } : {}),
				...(typeof mimeType === "string" ? { mimeType } : {}),
			});
		}
		parsed.attachments = attachments;
	}
	return parsed;
}

function parseAgentMessageStreamParams(
	params?: JsonValue,
): AgentMessageStreamParams {
	const parsedMessage = parseAgentMessageParams(params);
	const parsed: AgentMessageStreamParams = {
		...parsedMessage,
	};
	if (isRecord(params) && params.metadata !== undefined) {
		if (!isRecord(params.metadata)) {
			throw createApiBridgeError({
				code: "DECODE_FAILED",
				message: "agent.message.stream metadata must be an object.",
			});
		}
		parsed.metadata = params.metadata;
	}
	return parsed;
}

function parseStreamCancelParams(
	params?: JsonValue,
): AgentMessageStreamCancelParams {
	return { streamId: stringParam(params, "streamId") };
}

function parseMemorySearchParams(params?: JsonValue): {
	query: string;
	limit?: number;
	agentId?: string;
} {
	if (!isRecord(params)) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "memory.search params must be an object.",
		});
	}
	const query = params.query;
	if (typeof query !== "string" || query.trim().length === 0) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "memory.search query must be a non-empty string.",
		});
	}
	const parsed: { query: string; limit?: number; agentId?: string } = {
		query: query.trim(),
	};
	if (params.limit !== undefined) {
		if (typeof params.limit !== "number" || !Number.isFinite(params.limit)) {
			throw createApiBridgeError({
				code: "DECODE_FAILED",
				message: "memory.search limit must be a finite number.",
			});
		}
		parsed.limit = params.limit;
	}
	if (params.agentId !== undefined) {
		if (
			typeof params.agentId !== "string" ||
			params.agentId.trim().length === 0
		) {
			throw createApiBridgeError({
				code: "DECODE_FAILED",
				message: "memory.search agentId must be a non-empty string.",
			});
		}
		parsed.agentId = params.agentId.trim();
	}
	return parsed;
}

function currentApiBase(): string | null {
	return hostRuntimeAdapterAvailable
		? (hostRuntimeState?.apiBase ?? null)
		: manager.status().apiBase;
}

function withRuntimeApiBase(params?: JsonValue): JsonValue | undefined {
	const apiBase = currentApiBase();
	if (!apiBase) return params;
	if (params === undefined) return { apiBase };
	if (!isRecord(params) || Array.isArray(params)) return params;
	const object = params as { [key: string]: JsonValue };
	if (typeof object.apiBase === "string" && object.apiBase.length > 0) {
		return params;
	}
	return { ...object, apiBase };
}

function requestHost(
	hostMethod: HostRequestMessage["method"],
	params: JsonValue | undefined,
	runtimeMethod: RuntimeMethod,
	unavailableMessage: string,
): Promise<JsonValue | undefined> {
	const requestId = nextHostRequestId++;
	postHost({
		type: "host-request",
		requestId,
		method: hostMethod,
		...(params === undefined ? {} : { params }),
	});

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingHostRequests.delete(requestId);
			reject(
				createApiBridgeError({
					code: "CAPABILITY_UNAVAILABLE",
					message: unavailableMessage,
					method: runtimeMethod,
					details: "Timed out waiting for Satellite response.",
				}),
			);
		}, 30_000);
		pendingHostRequests.set(requestId, {
			method: runtimeMethod,
			unavailableMessage,
			resolve: (payload) => {
				clearTimeout(timeout);
				resolve(payload);
			},
			reject: (error) => {
				clearTimeout(timeout);
				reject(error);
			},
		});
	});
}

function invokeSatellite(
	satelliteId: string,
	unavailableMessage: string,
	method: RuntimeMethod,
	params?: JsonValue,
): Promise<JsonValue | undefined> {
	return requestHost(
		"invoke-carrot",
		{
			carrotId: satelliteId,
			method,
			...(params === undefined ? {} : { params }),
		},
		method,
		unavailableMessage,
	);
}

function isHostAgentStatus(value: JsonValue | undefined): value is {
	state: "not_started" | "starting" | "running" | "stopped" | "error";
	port: number | null;
	startedAt: number | null;
	error: string | null;
} {
	if (!isRecord(value)) return false;
	const state = value.state;
	return (
		(state === "not_started" ||
			state === "starting" ||
			state === "running" ||
			state === "stopped" ||
			state === "error") &&
		(typeof value.port === "number" || value.port === null) &&
		(typeof value.startedAt === "number" || value.startedAt === null) &&
		(typeof value.error === "string" || value.error === null)
	);
}

function hostAgentStatusToRuntimeState(
	status: JsonValue | undefined,
): RuntimeState {
	if (!isHostAgentStatus(status)) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "AgentManager status response was not valid.",
			details: status,
		});
	}
	const mode = status.state === "not_started" ? "stopped" : status.state;
	return {
		mode,
		cwd: "AgentManager",
		command: ["AgentManager"],
		apiBase:
			typeof status.port === "number"
				? `http://127.0.0.1:${status.port}`
				: null,
		pid: null,
		startedAt:
			typeof status.startedAt === "number"
				? new Date(status.startedAt).toISOString()
				: null,
		stoppedAt: status.state === "stopped" ? new Date().toISOString() : null,
		error: status.error,
	};
}

async function requestHostRuntimeState(
	hostMethod:
		| "agent-manager-start"
		| "agent-manager-stop"
		| "agent-manager-restart"
		| "agent-manager-status",
	runtimeMethod: RuntimeMethod,
): Promise<RuntimeState> {
	const payload = await requestHost(
		hostMethod,
		undefined,
		runtimeMethod,
		"AgentManager runtime adapter is not available",
	);
	hostRuntimeState = hostAgentStatusToRuntimeState(payload);
	return hostRuntimeState;
}

async function ensureHostRuntimeState(): Promise<RuntimeState> {
	if (hostRuntimeState) return hostRuntimeState;
	return requestHostRuntimeState("agent-manager-status", "runtime.status");
}

function hostLogTailToEntries(
	payload: JsonValue | undefined,
): RuntimeLogEntry[] {
	if (!isRecord(payload)) {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "AgentManager log response was not valid.",
			details: payload,
		});
	}
	const text = payload.text;
	if (typeof text !== "string") {
		throw createApiBridgeError({
			code: "DECODE_FAILED",
			message: "AgentManager log response did not include text.",
			details: payload,
		});
	}
	const timestamp = new Date().toISOString();
	return text
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => ({ timestamp, stream: "system", line }));
}

const logBuffer = new RuntimeLogBuffer();
const manager = new ElizaRuntimeManager({
	logBuffer,
	onEvent: (event: RuntimeManagerEvent) => {
		post({
			type: "event",
			name: event.name,
			payload: event.payload,
		});
	},
});
const apiClient = new ElizaRuntimeApiClient({
	getApiBase: currentApiBase,
	getAuthToken: () =>
		process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.MILADY_API_TOKEN ?? null,
});
const streamManager = new AgentStreamManager({
	getApiBase: currentApiBase,
	getAuthToken: () =>
		process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.MILADY_API_TOKEN ?? null,
	emit: (name, payload) => {
		post({
			type: "event",
			name: name as RuntimeManagerEvent["name"],
			payload: payload as RuntimeManagerEvent["payload"],
		});
	},
	log: (line) => {
		logBuffer.push("system", line);
	},
});

async function dispatch(
	request: RuntimeWorkerRequestMessage,
): Promise<RuntimeResponsePayload> {
	switch (request.method) {
		case "runtime.start":
			if (hostRuntimeAdapterAvailable) {
				return requestHostRuntimeState("agent-manager-start", request.method);
			}
			return manager.start(parseStartParams(request.params));
		case "runtime.stop":
			if (hostRuntimeAdapterAvailable) {
				return requestHostRuntimeState("agent-manager-stop", request.method);
			}
			return manager.stop();
		case "runtime.restart":
			if (hostRuntimeAdapterAvailable) {
				return requestHostRuntimeState("agent-manager-restart", request.method);
			}
			return manager.restart(parseStartParams(request.params));
		case "runtime.status":
			if (hostRuntimeAdapterAvailable) {
				return requestHostRuntimeState("agent-manager-status", request.method);
			}
			return manager.status();
		case "runtime.health":
			if (hostRuntimeAdapterAvailable) {
				await ensureHostRuntimeState();
				return requestHost(
					"agent-manager-health",
					undefined,
					request.method,
					"AgentManager runtime adapter is not available",
				);
			}
			return manager.health();
		case "runtime.logs.tail":
			if (hostRuntimeAdapterAvailable) {
				const limit = parseLogLimit(request.params);
				const payload = await requestHost(
					"agent-manager-logs-tail",
					limit === undefined
						? undefined
						: { maxBytes: Math.max(1, limit * 2048) },
					request.method,
					"AgentManager runtime adapter is not available",
				);
				return hostLogTailToEntries(payload).slice(-(limit ?? 100));
			}
			return manager.logsTail(parseLogLimit(request.params));
		case "api.discover":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.discover(parseDiscoverRefresh(request.params));
		case "api.status":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.status();
		case "agent.list":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.listAgents();
		case "agent.get":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.getAgent(stringParam(request.params, "agentId"));
		case "agent.message":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.sendMessage(parseAgentMessageParams(request.params));
		case "conversation.list":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.listConversations();
		case "conversation.get":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.getConversation(
				stringParam(request.params, "conversationId"),
			);
		case "plugin.list":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.listPlugins();
		case "memory.search":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.searchMemory(parseMemorySearchParams(request.params));
		case "config.get":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return apiClient.getConfig();
		case "agent.message.stream":
			if (hostRuntimeAdapterAvailable) await ensureHostRuntimeState();
			return streamManager.startMessageStream(
				parseAgentMessageStreamParams(request.params),
			);
		case "agent.message.stream.cancel":
			return streamManager.cancelStream(
				parseStreamCancelParams(request.params),
			);
		case "agent.message.stream.status":
			return streamManager.getStreamStatus(
				stringParam(request.params, "streamId"),
			);
		case "fs.status":
		case "fs.roots":
		case "fs.stat":
		case "fs.list":
		case "fs.readText":
		case "fs.search":
		case "fs.writeText":
			return invokeSatellite(
				FILE_SATELLITE_ID,
				"File Satellite eliza.fs is not available",
				request.method,
				request.params,
			);
		case "pty.status":
		case "pty.session.create":
		case "pty.session.list":
		case "pty.session.get":
		case "pty.session.write":
		case "pty.session.resize":
		case "pty.session.kill":
		case "pty.session.output.tail":
		case "pty.session.output.clear":
		case "pty.command.run":
			return invokeSatellite(
				TERMINAL_SATELLITE_ID,
				"Terminal Satellite eliza.pty is not available",
				request.method,
				request.params,
			);
		case "git.status":
		case "git.repo.info":
		case "git.branches":
		case "git.remotes":
		case "git.log":
		case "git.diff":
		case "git.show":
		case "git.add":
		case "git.restore":
		case "git.checkout":
		case "git.branch.create":
		case "git.branch.delete":
		case "git.commit":
		case "git.fetch":
		case "git.pull":
		case "git.push":
		case "git.operation.list":
		case "git.operation.get":
		case "git.command.run":
			return invokeSatellite(
				GIT_SATELLITE_ID,
				"Git Satellite eliza.git is not available",
				request.method,
				request.params,
			);
		case "model.status":
		case "model.hub":
		case "model.catalog":
		case "model.catalog.eliza1":
		case "model.eliza1.tiers":
		case "model.eliza1.voice":
		case "model.hf.metadata":
		case "model.providers":
		case "model.hardware":
		case "model.installed":
		case "model.download.start":
		case "model.download.cancel":
		case "model.downloads":
		case "model.active":
		case "model.activate":
		case "model.unload":
		case "model.assignments":
		case "model.assignment.set":
		case "model.routing":
		case "model.routing.set":
		case "model.routing.useLocal":
		case "model.routing.useCloud":
		case "model.generate":
		case "model.embedding":
		case "model.capabilities":
			return invokeSatellite(
				MODEL_SATELLITE_ID,
				"Model Satellite eliza.local-model is not available",
				request.method,
				withRuntimeApiBase(request.params),
			);
	}
	const exhaustive: never = request.method;
	throw new Error(`Unsupported runtime method: ${exhaustive}`);
}

self.addEventListener("message", (event) => {
	void (async () => {
		let request: RuntimeWorkerRequestMessage | null = null;
		try {
			if (isInitMessage(event.data)) {
				hostRuntimeAdapterAvailable = true;
				void requestHostRuntimeState(
					"agent-manager-status",
					"runtime.status",
				).catch((error) => {
					logBuffer.push(
						"system",
						`AgentManager adapter status probe failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				});
				return;
			}
			if (isHostResponse(event.data)) {
				completeHostRequest(event.data);
				return;
			}
			request = parseRequest(event.data);
			if (request === null) return;
			const payload = await dispatch(request);
			post({
				type: "response",
				requestId: request.requestId,
				success: true,
				payload,
			});
		} catch (error) {
			if (request === null) return;
			post({
				type: "response",
				requestId: request.requestId,
				success: false,
				error: serializeError(error),
			});
		}
	})();
});

post({ type: "ready" });
