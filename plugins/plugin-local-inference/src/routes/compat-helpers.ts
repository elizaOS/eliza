import crypto from "node:crypto";
import type http from "node:http";
import { isIP } from "node:net";
import { isLoopbackBindHost, resolveApiToken } from "@elizaos/shared";
import type { AgentRuntime } from "@elizaos/core";

const MAX_BODY_BYTES = 1_048_576;

export interface CompatRuntimeState {
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
		firstHeaderValue(req.headers["x-eliza-token"]) ??
		firstHeaderValue(req.headers["x-elizaos-token"]) ??
		firstHeaderValue(req.headers["x-api-key"]) ??
		firstHeaderValue(req.headers["x-api-token"])
	)?.trim() || null;
}

export function tokenMatches(expected: string, provided: string): boolean {
	const expectedBytes = Buffer.from(expected);
	const providedBytes = Buffer.from(provided);
	return (
		expectedBytes.length === providedBytes.length &&
		crypto.timingSafeEqual(expectedBytes, providedBytes)
	);
}

function isLoopbackRemoteAddress(remoteAddress: string | null | undefined): boolean {
	if (!remoteAddress) return false;
	const normalized = remoteAddress.trim().toLowerCase();
	return (
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "0:0:0:0:0:0:0:1" ||
		normalized === "::ffff:127.0.0.1" ||
		normalized === "::ffff:0:127.0.0.1"
	);
}

function headerList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	return (Array.isArray(value) ? value : [value])
		.flatMap((entry) => entry.split(","))
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function proxyClientHeaderBlocksLocalTrust(
	headers: http.IncomingHttpHeaders,
): boolean {
	for (const name of [
		"forwarded",
		"forwarded-for",
		"x-forwarded",
		"x-forwarded-for",
		"x-original-forwarded-for",
		"x-real-ip",
		"x-client-ip",
		"x-forwarded-client-ip",
		"x-cluster-client-ip",
		"cf-connecting-ip",
		"true-client-ip",
		"fastly-client-ip",
		"x-appengine-user-ip",
		"x-azure-clientip",
	]) {
		const values = headerList(headers[name]);
		for (const value of values) {
			const host = value.replace(/^\[|\]$/g, "").split(":")[0];
			if (host && isIP(host) && !isLoopbackRemoteAddress(host)) return true;
		}
	}
	return false;
}

function isCloudProvisionedByEnv(): boolean {
	return process.env.ELIZA_CLOUD_PROVISIONED === "1";
}

function isLocalAuthRequiredByEnv(): boolean {
	return process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1";
}

function isTrustedLocalOrigin(raw: string): boolean {
	const trimmed = raw.trim();
	if (!trimmed || trimmed === "null") return true;
	try {
		const parsed = new URL(trimmed);
		if (
			parsed.protocol === "file:" ||
			parsed.protocol === "app:" ||
			parsed.protocol === "tauri:" ||
			parsed.protocol === "capacitor:" ||
			parsed.protocol === "capacitor-electron:" ||
			parsed.protocol === "electrobun:"
		) {
			return true;
		}
		return isLoopbackBindHost(parsed.hostname);
	} catch {
		return false;
	}
}

export function isTrustedLocalRequest(
	req: Pick<http.IncomingMessage, "headers" | "socket">,
): boolean {
	if (isLocalAuthRequiredByEnv()) return false;
	if (isCloudProvisionedByEnv()) return false;
	if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false;
	if (proxyClientHeaderBlocksLocalTrust(req.headers)) return false;

	const host = firstHeaderValue(req.headers.host);
	if (host && !isLoopbackBindHost(host)) return false;

	const secFetchSite = firstHeaderValue(
		req.headers["sec-fetch-site"],
	)?.toLowerCase();
	if (secFetchSite === "cross-site") return false;

	const origin = firstHeaderValue(req.headers.origin);
	if (origin && !isTrustedLocalOrigin(origin)) return false;

	const referer = firstHeaderValue(req.headers.referer);
	if (!origin && referer && !isTrustedLocalOrigin(referer)) return false;

	return true;
}

function scrubStackFields(value: unknown): unknown {
	if (value instanceof Error) return { error: value.message || "Internal error" };
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
): void {
	sendJson(res, status, { error: message });
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
	_state: CompatRuntimeState,
): Promise<boolean> {
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

	const chunks: Buffer[] = [];
	let totalBytes = 0;
	try {
		for await (const chunk of req) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalBytes += buf.length;
			if (totalBytes > MAX_BODY_BYTES) {
				req.destroy();
				sendJsonError(res, 413, "Request body too large");
				return null;
			}
			chunks.push(buf);
		}
	} catch {
		sendJsonError(res, 400, "Invalid request body");
		return null;
	}

	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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
