/**
 * Task Agent API Routes — Dispatcher
 *
 * Provides shared helpers (parseBody, sendJson, sendError), types, and the
 * top-level route dispatcher that delegates to domain-specific route modules.
 *
 * @module api/routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import type { PTYService } from "../services/pty-service.ts";
import type { SwarmCoordinator } from "../services/swarm-coordinator.ts";
import type { CodingWorkspaceService } from "../services/workspace-service.ts";
import { handleAgentRoutes } from "./agent-routes.ts";
import { handleCoordinatorRoutes } from "./coordinator-routes.ts";
import { handleHookRoutes } from "./hook-routes.ts";
import { handleIssueRoutes } from "./issue-routes.ts";
import { handleWorkspaceRoutes } from "./workspace-routes.ts";

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface RouteContext {
	runtime: IAgentRuntime;
	ptyService: PTYService | null;
	workspaceService: CodingWorkspaceService | null;
	coordinator?: SwarmCoordinator;
}

// Max request body size (1 MB)
export const MAX_BODY_SIZE = 1024 * 1024;

// Helper to parse JSON body with size limit
export async function parseBody(
	req: IncomingMessage,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let body = "";
		let size = 0;
		req.on("data", (chunk: Buffer | string) => {
			size += typeof chunk === "string" ? chunk.length : chunk.byteLength;
			if (size > MAX_BODY_SIZE) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			body += chunk;
		});
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

// Helper to send JSON response
export function sendJson(
	res: ServerResponse,
	data: JsonValue,
	status = 200,
): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

// Helper to send error
export function sendError(
	res: ServerResponse,
	message: string,
	status = 400,
): void {
	sendJson(res, { error: message }, status);
}

/**
 * Handle task-agent routes
 * Returns true if the route was handled, false otherwise
 */
export async function handleCodingAgentRoutes(
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
	ctx: RouteContext,
): Promise<boolean> {
	const normalizedPathname = pathname.startsWith("/api/task-agents")
		? pathname.replace(/^\/api\/task-agents/, "/api/coding-agents")
		: pathname;

	// Delegate to hook routes first — hooks need fast responses
	if (await handleHookRoutes(req, res, normalizedPathname, ctx)) {
		return true;
	}

	// Delegate to coordinator routes (before agent routes — more specific prefix)
	if (await handleCoordinatorRoutes(req, res, normalizedPathname, ctx)) {
		return true;
	}

	// Delegate to agent routes
	if (await handleAgentRoutes(req, res, normalizedPathname, ctx)) {
		return true;
	}

	// Delegate to workspace routes
	if (await handleWorkspaceRoutes(req, res, normalizedPathname, ctx)) {
		return true;
	}

	// Delegate to issue routes
	if (await handleIssueRoutes(req, res, normalizedPathname, ctx)) {
		return true;
	}

	// Route not handled
	return false;
}

/**
 * Create route handler with services from runtime
 */
export function createCodingAgentRouteHandler(
	runtime: IAgentRuntime,
	coordinator?: SwarmCoordinator,
) {
	return (req: IncomingMessage, res: ServerResponse, pathname: string) => {
		const ctx: RouteContext = {
			runtime,
			ptyService: runtime.getService(
				"PTY_SERVICE",
			) as unknown as PTYService | null,
			workspaceService: runtime.getService(
				"CODING_WORKSPACE_SERVICE",
			) as unknown as CodingWorkspaceService | null,
			coordinator:
				coordinator ??
				(runtime.getService("SWARM_COORDINATOR") as unknown as
					| SwarmCoordinator
					| undefined),
		};
		return handleCodingAgentRoutes(req, res, pathname, ctx);
	};
}

export const createTaskAgentRouteHandler = createCodingAgentRouteHandler;
