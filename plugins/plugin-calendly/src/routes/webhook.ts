/**
 * @module routes/webhook
 * @description POST /calendly/webhook.
 *
 * Validates the envelope shape and emits a `CALENDLY_WEBHOOK` runtime event so
 * other plugins can react to Calendly deliveries (invitee.created, canceled,
 * etc.) without coupling to this plugin's internals.
 *
 * Signature verification against `CALENDLY_WEBHOOK_SIGNING_KEY` is deferred
 * per the plan — the parameter is declared in `package.json` so operators can
 * configure it in advance.
 */

import type {
	IAgentRuntime,
	Route,
	RouteBodyValue,
	RouteRequest,
	RouteResponse,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { CalendlyWebhookEvent } from "../types.js";

const VALID_EVENTS: ReadonlySet<CalendlyWebhookEvent["event"]> = new Set([
	"invitee.created",
	"invitee.canceled",
	"invitee_no_show.created",
	"invitee_no_show.deleted",
	"routing_form_submission.created",
]);

function parsePayload(
	body: Record<string, RouteBodyValue> | undefined,
): CalendlyWebhookEvent | null {
	if (!body || typeof body !== "object") {
		return null;
	}
	const { event, created_at, created_by, payload } = body as Record<
		string,
		unknown
	>;
	if (typeof event !== "string" || !VALID_EVENTS.has(event as CalendlyWebhookEvent["event"])) {
		return null;
	}
	if (typeof created_at !== "string" || typeof created_by !== "string") {
		return null;
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	return {
		event: event as CalendlyWebhookEvent["event"],
		created_at,
		created_by,
		payload: payload as Record<string, unknown>,
	};
}

export const calendlyWebhookRoute: Route = {
	type: "POST",
	path: "/calendly/webhook",
	name: "calendly-webhook",
	public: true,
	handler: async (
		req: RouteRequest,
		res: RouteResponse,
		runtime: IAgentRuntime,
	): Promise<void> => {
		const parsed = parsePayload(req.body);
		if (!parsed) {
			res.status(400).json({ ok: false, error: "invalid-calendly-webhook-payload" });
			return;
		}
		logger.info(
			{ event: parsed.event, createdAt: parsed.created_at },
			"[Calendly:webhook] received",
		);
		await runtime.emitEvent("CALENDLY_WEBHOOK", {
			runtime,
			source: "calendly",
			event: parsed,
		});
		res.status(200).json({ ok: true });
	},
};
