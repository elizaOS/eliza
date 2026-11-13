/**
 * Request API-token helpers shared by every host and plugin HTTP route that
 * accepts the configured API token.
 */
import { timingSafeEqual } from "node:crypto";
import type http from "node:http";

/** First value of a possibly multi-valued HTTP header, or null when absent. */
export function firstHeaderValue(
	value: string | string[] | undefined,
): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return null;
}

/**
 * Timing-safe token equality. Both values are padded to one length so the
 * comparison time does not reveal the expected token's length.
 */
export function tokenMatches(expected: string, provided: string): boolean {
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	const length = Math.max(a.length, b.length);
	const paddedA = Buffer.alloc(length);
	const paddedB = Buffer.alloc(length);
	a.copy(paddedA);
	b.copy(paddedB);
	const contentMatches = timingSafeEqual(paddedA, paddedB);
	return a.length === b.length && contentMatches;
}

/**
 * Extract the API token from an incoming request.
 *
 * Checks (in order):
 *   1. `Authorization: Bearer <token>`
 *   2. `x-eliza-token`
 *   3. `x-elizaos-token`
 *   4. `x-api-key` / `x-api-token`
 */
export function getProvidedApiToken(
	req: Pick<http.IncomingMessage, "headers">,
): string | null {
	const authHeader = firstHeaderValue(req.headers.authorization)?.trim();
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
