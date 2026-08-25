/**
 * Shared-secret authentication for the inbound BlueBubbles webhook.
 *
 * Resolves the expected `X-BlueBubbles-Webhook-Secret` from runtime settings or
 * env, extracts the header off a `RouteRequest` (case-insensitive, array-safe),
 * and compares them with a constant-time `timingSafeEqual`. The POST
 * `/webhooks/bluebubbles` handler in `data-routes.ts` gates every inbound event
 * through `isBlueBubblesWebhookAuthorized`; a missing configured secret fails
 * closed (unauthorized), so the webhook is never open by default.
 */
import crypto from "node:crypto";
import type { IAgentRuntime, RouteRequest } from "@elizaos/core";

export const BLUEBUBBLES_WEBHOOK_SECRET_HEADER = "X-BlueBubbles-Webhook-Secret";

export function resolveBlueBubblesWebhookSecret(
	runtime: IAgentRuntime,
): string | null {
	const fromSetting = runtime.getSetting("BLUEBUBBLES_WEBHOOK_SECRET");
	if (typeof fromSetting === "string" && fromSetting.trim()) {
		return fromSetting.trim();
	}
	const fromEnv = process.env.BLUEBUBBLES_WEBHOOK_SECRET;
	if (typeof fromEnv === "string" && fromEnv.trim()) {
		return fromEnv.trim();
	}
	return null;
}

export function readRouteHeader(
	req: RouteRequest,
	name: string,
): string | undefined {
	const headers = req.headers;
	if (!headers) return undefined;
	const key = name.toLowerCase();
	const value = headers[key] ?? headers[name] ?? headers[name.toUpperCase()];
	if (Array.isArray(value)) {
		return value[0];
	}
	return typeof value === "string" ? value : undefined;
}

export function verifyBlueBubblesWebhookSecret(
	expected: string,
	provided: string | undefined,
): boolean {
	if (!expected || !provided) {
		return false;
	}
	const expectedBuffer = Buffer.from(expected, "utf8");
	const providedBuffer = Buffer.from(provided, "utf8");
	if (expectedBuffer.length !== providedBuffer.length) {
		return false;
	}
	return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function isBlueBubblesWebhookAuthorized(
	runtime: IAgentRuntime,
	req: RouteRequest,
): boolean {
	const expected = resolveBlueBubblesWebhookSecret(runtime);
	if (!expected) {
		return false;
	}
	return verifyBlueBubblesWebhookSecret(
		expected,
		readRouteHeader(req, BLUEBUBBLES_WEBHOOK_SECRET_HEADER),
	);
}
