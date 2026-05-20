import { createApiBridgeError } from "./errors.ts";
import type {
	ApiDiscoveryResult,
	ApiRouteStatus,
	ApiRouteStatusMethod,
	StreamingRouteStatus,
} from "./protocol.ts";

type ProbeMethod = ApiRouteStatusMethod | "HEAD";

type CandidateRoute = {
	name: string;
	method: ApiRouteStatusMethod;
	path: string;
	probeMethod: ProbeMethod;
	safelyConfirmable: boolean;
};

type StreamingCandidateRoute = {
	name: string;
	method: "GET" | "POST";
	path: string;
	probeMethod: ProbeMethod;
	safelyConfirmable: boolean;
};

const DEFAULT_TIMEOUT_MS = 1200;

const CANDIDATE_ROUTES: CandidateRoute[] = [
	{
		name: "status.devStack",
		method: "GET",
		path: "/api/dev/stack",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "status.status",
		method: "GET",
		path: "/api/status",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "status.health",
		method: "GET",
		path: "/api/health",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "agents.api",
		method: "GET",
		path: "/api/agents",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "agents.root",
		method: "GET",
		path: "/agents",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "agents.runtime",
		method: "GET",
		path: "/api/runtime/agents",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "conversations.api",
		method: "GET",
		path: "/api/conversations",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "conversations.root",
		method: "GET",
		path: "/conversations",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "plugins.api",
		method: "GET",
		path: "/api/plugins",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "plugins.root",
		method: "GET",
		path: "/plugins",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "memory.apiPost",
		method: "POST",
		path: "/api/memory/search",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "memory.memoriesPost",
		method: "POST",
		path: "/api/memories/search",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "memory.rootPost",
		method: "POST",
		path: "/memory/search",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "chat.api",
		method: "POST",
		path: "/api/chat",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "chat.messages",
		method: "POST",
		path: "/api/messages",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "chat.agentMessage",
		method: "POST",
		path: "/api/agents/message",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "chat.root",
		method: "POST",
		path: "/message",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "config.api",
		method: "GET",
		path: "/api/config",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "memory.apiGet",
		method: "GET",
		path: "/api/memory/search?q=__elizalaunch_probe__&limit=1",
		probeMethod: "GET",
		safelyConfirmable: true,
	},
	{
		name: "conversation.message",
		method: "POST",
		path: "/api/conversations/:conversationId/messages",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
];

const STREAMING_CANDIDATE_ROUTES: StreamingCandidateRoute[] = [
	{
		name: "stream.conversationMessage",
		method: "POST",
		path: "/api/conversations/:conversationId/messages/stream",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "stream.conversationMessageQuery",
		method: "POST",
		path: "/api/conversations/:conversationId/messages?stream=true",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "stream.openaiCompat",
		method: "POST",
		path: "/v1/chat/completions",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "stream.anthropicCompat",
		method: "POST",
		path: "/v1/messages",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "stream.chat",
		method: "POST",
		path: "/api/chat/stream",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "stream.messages",
		method: "POST",
		path: "/api/messages/stream",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "stream.agentMessage",
		method: "POST",
		path: "/api/agents/message/stream",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "stream.root",
		method: "POST",
		path: "/api/stream",
		probeMethod: "OPTIONS",
		safelyConfirmable: false,
	},
	{
		name: "stream.conversationEvents",
		method: "GET",
		path: "/api/conversations/:conversationId/events",
		probeMethod: "GET",
		safelyConfirmable: false,
	},
	{
		name: "stream.conversationGet",
		method: "GET",
		path: "/api/conversations/:conversationId/stream",
		probeMethod: "GET",
		safelyConfirmable: false,
	},
];

let cachedDiscovery: ApiDiscoveryResult | null = null;

function joinApiPath(apiBase: string, path: string): string {
	const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
	return `${base}${path}`;
}

function errorMessage(error: Error): string {
	return error.message.length > 0 ? error.message : error.name;
}

async function probeRoute(
	apiBase: string,
	candidate: CandidateRoute,
	timeoutMs: number,
): Promise<ApiRouteStatus> {
	if (!candidate.safelyConfirmable) {
		return {
			name: candidate.name,
			method: candidate.method,
			path: candidate.path,
			available: false,
			error: "Route requires a real request and was not mutated during discovery.",
		};
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(joinApiPath(apiBase, candidate.path), {
			method: candidate.probeMethod,
			signal: controller.signal,
		});
		return {
			name: candidate.name,
			method: candidate.method,
			path: candidate.path,
			available: response.status >= 200 && response.status < 400,
			status: response.status,
			...(response.status >= 200 && response.status < 400
				? {}
				: { error: `HTTP ${response.status}` }),
		};
	} catch (error) {
		const message =
			error instanceof Error ? errorMessage(error) : "Route probe failed";
		return {
			name: candidate.name,
			method: candidate.method,
			path: candidate.path,
			available: false,
			error: message,
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function probeStreamingRoute(
	apiBase: string,
	candidate: StreamingCandidateRoute,
	timeoutMs: number,
): Promise<StreamingRouteStatus> {
	if (candidate.path.includes(":conversationId") || !candidate.safelyConfirmable) {
		return {
			name: candidate.name,
			method: candidate.method,
			path: candidate.path,
			available: false,
			error: "Streaming route was not safely probed without sending a message.",
		};
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(joinApiPath(apiBase, candidate.path), {
			method: candidate.probeMethod,
			signal: controller.signal,
		});
		return {
			name: candidate.name,
			method: candidate.method,
			path: candidate.path,
			available: response.status >= 200 && response.status < 400,
			status: response.status,
			...(response.status >= 200 && response.status < 400
				? {}
				: { error: `HTTP ${response.status}` }),
		};
	} catch (error) {
		const message =
			error instanceof Error ? errorMessage(error) : "Streaming route probe failed";
		return {
			name: candidate.name,
			method: candidate.method,
			path: candidate.path,
			available: false,
			error: message,
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function discoverRuntimeApiRoutes(options: {
	apiBase: string | null;
	timeoutMs?: number;
	refresh?: boolean;
}): Promise<ApiDiscoveryResult> {
	if (options.apiBase === null || options.apiBase.trim().length === 0) {
		throw createApiBridgeError({
			code: "API_BASE_MISSING",
			message: "Runtime API base is not configured.",
		});
	}
	const apiBase = options.apiBase.trim();
	if (
		cachedDiscovery !== null &&
		cachedDiscovery.apiBase === apiBase &&
		options.refresh !== true
	) {
		return cachedDiscovery;
	}
	const routes = await Promise.all(
		CANDIDATE_ROUTES.map((candidate) =>
			probeRoute(apiBase, candidate, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		),
	);
	const streamingRoutes = await Promise.all(
		STREAMING_CANDIDATE_ROUTES.map((candidate) =>
			probeStreamingRoute(
				apiBase,
				candidate,
				options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			),
		),
	);
	cachedDiscovery = { apiBase, routes, streamingRoutes };
	return cachedDiscovery;
}

export function clearRuntimeApiDiscoveryCache(): void {
	cachedDiscovery = null;
}

export function findAvailableRoute(
	discovery: ApiDiscoveryResult | null,
	names: string[],
): ApiRouteStatus | null {
	if (discovery === null) return null;
	for (const name of names) {
		const route = discovery.routes.find((candidate) => candidate.name === name);
		if (route?.available === true) return route;
	}
	return null;
}

export function findAvailableStreamingRoute(
	discovery: ApiDiscoveryResult | null,
	names: string[],
): StreamingRouteStatus | null {
	if (discovery === null) return null;
	for (const name of names) {
		const route = discovery.streamingRoutes.find(
			(candidate) => candidate.name === name,
		);
		if (route?.available === true) return route;
	}
	return null;
}
