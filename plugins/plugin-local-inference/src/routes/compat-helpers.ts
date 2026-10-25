import { readRequestBodyBuffer } from "@elizaos/host";
/**
 * Shared auth and I/O helpers for the local-inference compat HTTP routes.
 *
 * Every `*-compat-routes.ts` handler authorizes through here: a request is
 * trusted when it arrives on loopback with no proxy-forwarding header and a
 * same-origin/loopback Host (`isTrustedLocalRequest`), otherwise it must present
 * the configured API token (`getCompatApiToken`, constant-time `tokenMatches`).
 * Also provides bounded JSON body reading and the JSON responders, which scrub
 * `Error`/`stack` fields so a route failure never leaks a stack trace to callers.
 */

import crypto from "node:crypto";
import type http from "node:http";
import {
	type AgentRuntime,
	isTrustedLocalRequest as isCoreTrustedLocalRequest,
} from "@elizaos/core";
import { readAliasedEnv, resolveApiToken } from "@elizaos/host/protocol";

const MAX_BODY_BYTES = 1_048_576;

export interface CompatRuntimeState {
	/** In-process host auth resolver; never populated from request headers/body. */
	authorizeRequest?: (
		req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
		res: http.ServerResponse,
	) => Promise<boolean>;
	current: AgentRuntime | null;
	pendingAgentName?: string | null;
	pendingRestartReasons?: string[];
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return null;
}

export function getCompatApiToken(): string | null {
	return resolveApiToken(process.env);
}

export function getProvidedApiToken(
	req: Pick<http.IncomingMessage, "headers">,
): string | null {
	const authHeader = firstHeaderValue(req.headers.authorization)
		?.slice(0, 1024)
		.trim();
	if (authHeader) {
		const match = /^Bearer\s{1,8}(.+)$/i.exec(authHeader);
		if (match?.[1]) return match[1].trim();
	}
	return (
		(
			firstHeaderValue(req.headers["x-eliza-token"]) ??
			firstHeaderValue(req.headers["x-elizaos-token"]) ??
			firstHeaderValue(req.headers["x-api-key"]) ??
			firstHeaderValue(req.headers["x-api-token"])
		)?.trim() || null
	);
}

export function tokenMatches(expected: string, provided: string): boolean {
	const expectedBytes = Buffer.from(expected);
	const providedBytes = Buffer.from(provided);
	return (
		expectedBytes.length === providedBytes.length &&
		crypto.timingSafeEqual(expectedBytes, providedBytes)
	);
}

function isCloudProvisionedByEnv(): boolean {
	return readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1";
}

function isLocalAuthRequiredByEnv(): boolean {
	return process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1";
}

function isTrustedLocalRequest(
	req: Pick<http.IncomingMessage, "headers" | "socket">,
): boolean {
	return isCoreTrustedLocalRequest(req, {
		localAuthRequired: isLocalAuthRequiredByEnv(),
		cloudProvisioned: isCloudProvisionedByEnv(),
	});
}

function scrubStackFields(value: unknown): unknown {
	if (value instanceof Error)
		return { error: value.message || "Internal error" };
	if (Array.isArray(value)) return value.map(scrubStackFields);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			if (key === "stack" || key === "stackTrace") continue;
			out[key] = scrubStackFields(nested);
		}
		return out;
	}
	return value;
}

export function sendJson(
	res: http.ServerResponse,
	status: number,
	body: unknown,
): void {
	if (res.headersSent) return;
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(scrubStackFields(body)));
}

export function sendJsonError(
	res: http.ServerResponse,
	status: number,
	message: string,
	extra?: Record<string, unknown>,
): void {
	sendJson(res, status, { error: message, ...extra });
}

export function ensureCompatApiAuthorized(
	req: Pick<http.IncomingMessage, "headers" | "socket">,
	res: http.ServerResponse,
): boolean {
	if (isTrustedLocalRequest(req)) return true;
	const expectedToken = getCompatApiToken();
	if (!expectedToken) {
		sendJsonError(res, 401, "Unauthorized");
		return false;
	}
	const providedToken = getProvidedApiToken(req);
	if (providedToken && tokenMatches(expectedToken, providedToken)) return true;
	sendJsonError(res, 401, "Unauthorized");
	return false;
}

export function ensureCompatSensitiveRouteAuthorized(
	req: Pick<http.IncomingMessage, "headers" | "socket">,
	res: http.ServerResponse,
): boolean {
	if (!getCompatApiToken()) {
		if (isTrustedLocalRequest(req)) return true;
		sendJsonError(
			res,
			403,
			"Sensitive endpoint requires API token authentication",
		);
		return false;
	}
	return ensureCompatApiAuthorized(req, res);
}

export async function ensureRouteAuthorized(
	req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
	res: http.ServerResponse,
	state: CompatRuntimeState,
): Promise<boolean> {
	if (state.authorizeRequest) return state.authorizeRequest(req, res);
	return ensureCompatApiAuthorized(req, res);
}

export async function readCompatJsonBody(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
	const preParsed = (req as { body?: unknown }).body;
	if (preParsed && typeof preParsed === "object" && !Array.isArray(preParsed)) {
		return preParsed as Record<string, unknown>;
	}

	let buffered: Buffer | null;
	try {
		buffered = await readRequestBodyBuffer(req, { maxBytes: MAX_BODY_BYTES });
	} catch (error) {
		const tooLarge =
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "HTTP_REQUEST_BODY_TOO_LARGE";
		sendJsonError(
			res,
			tooLarge ? 413 : 400,
			tooLarge ? "Request body too large" : "Invalid request body",
		);
		return null;
	}
	const chunks = buffered && buffered.length ? [buffered] : [];

	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(
			Buffer.concat(chunks).toString("utf8"),
		) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			sendJsonError(res, 400, "Invalid JSON body");
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		sendJsonError(res, 400, "Invalid JSON body");
		return null;
	}
}
