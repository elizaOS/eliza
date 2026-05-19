/**
 * BlueBubbles connector post-setup data + webhook routes.
 *
 * These routes live outside the setup contract (`/api/setup/bluebubbles/`):
 *
 *   GET  /api/bluebubbles/chats        list chats via the BlueBubbles client
 *   GET  /api/bluebubbles/messages     read messages for a chat
 *   POST /webhooks/bluebubbles         public webhook receiver (no auth)
 *
 * Each handler pulls the BlueBubblesService instance off the runtime via
 * `runtime.getService("bluebubbles")` and calls public methods. If the
 * service isn't registered we return a `service_unavailable` envelope so
 * the UI can render an informative empty state.
 */

import type {
	IAgentRuntime,
	Route,
	RouteRequest,
	RouteResponse,
} from "@elizaos/core";

const BLUEBUBBLES_SERVICE_NAME = "bluebubbles";
const DEFAULT_WEBHOOK_PATH = "/webhooks/bluebubbles";

type BlueBubblesWebhookPayload = {
	type: string;
	data: Record<string, unknown>;
};

type BlueBubblesChat = Record<string, unknown>;
type BlueBubblesMessage = Record<string, unknown>;

interface BlueBubblesClientLike {
	listChats(limit?: number, offset?: number): Promise<BlueBubblesChat[]>;
	getMessages(
		chatGuid: string,
		limit?: number,
		offset?: number,
	): Promise<BlueBubblesMessage[]>;
}

interface BlueBubblesServiceLike {
	isConnected(): boolean;
	getWebhookPath(): string;
	getClient(): BlueBubblesClientLike | null;
	handleWebhook(payload: BlueBubblesWebhookPayload): Promise<void>;
}

interface SetupErrorResponse {
	error: { code: string; message: string };
}

function setupError(code: string, message: string): SetupErrorResponse {
	return { error: { code, message } };
}

function resolveService(runtime: IAgentRuntime): BlueBubblesServiceLike | null {
	const raw = runtime.getService(BLUEBUBBLES_SERVICE_NAME);
	return (raw as BlueBubblesServiceLike | null | undefined) ?? null;
}

// ── GET /api/bluebubbles/chats ─────────────────────────────────────
async function handleChats(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res
			.status(503)
			.json(
				setupError("service_unavailable", "bluebubbles service not registered"),
			);
		return;
	}
	const client = service.getClient();
	if (!client) {
		res
			.status(503)
			.json(
				setupError("service_unavailable", "bluebubbles client not available"),
			);
		return;
	}
	const url = new URL(req.url ?? "/api/bluebubbles/chats", "http://localhost");
	const limit = Math.min(
		Math.max(
			1,
			Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100,
		),
		500,
	);
	const offset = Math.max(
		0,
		Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
	);
	try {
		const chats = await client.listChats(limit, offset);
		res.status(200).json({ chats, count: chats.length, limit, offset });
	} catch (error) {
		res
			.status(500)
			.json(
				setupError(
					"internal_error",
					`failed to read bluebubbles chats: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	}
}

// ── GET /api/bluebubbles/messages ──────────────────────────────────
async function handleMessages(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res
			.status(503)
			.json(
				setupError("service_unavailable", "bluebubbles service not registered"),
			);
		return;
	}
	const client = service.getClient();
	if (!client) {
		res
			.status(503)
			.json(
				setupError("service_unavailable", "bluebubbles client not available"),
			);
		return;
	}
	const url = new URL(
		req.url ?? "/api/bluebubbles/messages",
		"http://localhost",
	);
	const chatGuid = (url.searchParams.get("chatGuid") ?? "").trim();
	if (!chatGuid) {
		res
			.status(400)
			.json(setupError("bad_request", "chatGuid query parameter is required"));
		return;
	}
	const limit = Math.min(
		Math.max(
			1,
			Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
		),
		500,
	);
	const offset = Math.max(
		0,
		Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
	);
	try {
		const messages = await client.getMessages(chatGuid, limit, offset);
		res.status(200).json({
			chatGuid,
			messages,
			count: messages.length,
			limit,
			offset,
		});
	} catch (error) {
		res
			.status(500)
			.json(
				setupError(
					"internal_error",
					`failed to read bluebubbles messages: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	}
}

// ── POST /webhooks/bluebubbles ─────────────────────────────────────
async function handleWebhook(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res
			.status(503)
			.json(
				setupError("service_unavailable", "bluebubbles service not registered"),
			);
		return;
	}
	const payload = req.body as BlueBubblesWebhookPayload | undefined;
	if (
		!payload ||
		typeof payload.type !== "string" ||
		!payload.type.trim() ||
		typeof payload.data !== "object" ||
		payload.data === null ||
		Array.isArray(payload.data)
	) {
		res
			.status(400)
			.json(setupError("bad_request", "invalid BlueBubbles webhook payload"));
		return;
	}
	try {
		await service.handleWebhook(payload);
		res.status(200).json({ ok: true });
	} catch (error) {
		res
			.status(500)
			.json(
				setupError(
					"internal_error",
					`failed to handle bluebubbles webhook: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	}
}

export const blueBubblesDataRoutes: Route[] = [
	{
		type: "GET",
		path: "/api/bluebubbles/chats",
		handler: handleChats,
		rawPath: true,
	},
	{
		type: "GET",
		path: "/api/bluebubbles/messages",
		handler: handleMessages,
		rawPath: true,
	},
	{
		type: "POST",
		path: DEFAULT_WEBHOOK_PATH,
		handler: handleWebhook,
		rawPath: true,
		public: true,
		name: "bluebubbles-webhook",
	},
];
