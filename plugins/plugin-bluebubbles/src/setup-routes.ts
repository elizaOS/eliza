/**
 * BlueBubbles connector HTTP routes.
 *
 * Exposes the @elizaos/plugin-bluebubbles service state through the Plugin
 * routes API so the dashboard, CLIs, and the BlueBubbles webhook target
 * have stable HTTP endpoints to call.
 *
 * Routes served:
 *
 *   GET  /api/bluebubbles/status     service health + webhook path
 *   GET  /api/bluebubbles/chats      list chats from the BlueBubbles server
 *   GET  /api/bluebubbles/messages   list messages for a chat
 *   POST /webhooks/bluebubbles       webhook receiver (path is service-configurable)
 *
 * The webhook path is read from `service.getWebhookPath()`. We register a
 * route at the default `/webhooks/bluebubbles` path; if the service is
 * configured to use a different path, that path is exposed via the runtime
 * plugin route system through the same handler — but we keep the default
 * here since the runtime route table is keyed by the path string.
 *
 * Each handler pulls the BlueBubblesService instance off the runtime via
 * `runtime.getService("bluebubbles")` and calls public methods. If the
 * service isn't registered we return 503 with a structured reason so the
 * UI can render an informative empty state.
 *
 * Routes are registered with `rawPath: true` so they mount at their
 * legacy paths without the plugin-name prefix.
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

function resolveService(runtime: IAgentRuntime): BlueBubblesServiceLike | null {
	const raw = runtime.getService(BLUEBUBBLES_SERVICE_NAME);
	return (raw as BlueBubblesServiceLike | null | undefined) ?? null;
}

/**
 * Resolve the webhook path the BlueBubbles service is currently listening on.
 * Used by the agent's auth gate so webhook deliveries bypass auth even when
 * the service has been configured with a custom path.
 *
 * Exported so the agent shell can compute the same value the plugin uses.
 */
export function resolveBlueBubblesWebhookPath(
	runtime: IAgentRuntime | null | undefined,
): string {
	if (!runtime) return DEFAULT_WEBHOOK_PATH;
	const service = resolveService(runtime);
	const configuredPath = service?.getWebhookPath();
	if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
		return configuredPath.trim();
	}
	return DEFAULT_WEBHOOK_PATH;
}

// ── GET /api/bluebubbles/status ────────────────────────────────────
async function handleStatus(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	const webhookPath = resolveBlueBubblesWebhookPath(runtime);
	if (!service) {
		res.status(200).json({
			available: false,
			connected: false,
			webhookPath,
			reason: "bluebubbles service not registered",
		});
		return;
	}
	res.status(200).json({
		available: true,
		connected: service.isConnected(),
		webhookPath,
	});
}

// ── GET /api/bluebubbles/chats ─────────────────────────────────────
async function handleChats(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res.status(503).json({ error: "bluebubbles service not registered" });
		return;
	}
	const client = service.getClient();
	if (!client) {
		res.status(503).json({ error: "bluebubbles client not available" });
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
		res.status(500).json({
			error: `failed to read bluebubbles chats: ${error instanceof Error ? error.message : String(error)}`,
		});
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
		res.status(503).json({ error: "bluebubbles service not registered" });
		return;
	}
	const client = service.getClient();
	if (!client) {
		res.status(503).json({ error: "bluebubbles client not available" });
		return;
	}
	const url = new URL(
		req.url ?? "/api/bluebubbles/messages",
		"http://localhost",
	);
	const chatGuid = (url.searchParams.get("chatGuid") ?? "").trim();
	if (!chatGuid) {
		res.status(400).json({ error: "chatGuid query parameter is required" });
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
		res.status(500).json({
			error: `failed to read bluebubbles messages: ${error instanceof Error ? error.message : String(error)}`,
		});
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
		res.status(503).json({ error: "bluebubbles service not registered" });
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
		res.status(400).json({ error: "invalid BlueBubbles webhook payload" });
		return;
	}
	try {
		await service.handleWebhook(payload);
		res.status(200).json({ ok: true });
	} catch (error) {
		res.status(500).json({
			error: `failed to handle bluebubbles webhook: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

/**
 * Plugin routes for BlueBubbles.
 * Registered with `rawPath: true` to preserve legacy paths.
 *
 * The webhook is registered as a public route (no auth required) since the
 * BlueBubbles server posts to it from outside the loopback API.
 */
export const blueBubblesSetupRoutes: Route[] = [
	{
		type: "GET",
		path: "/api/bluebubbles/status",
		handler: handleStatus,
		rawPath: true,
	},
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
