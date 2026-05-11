/**
 * BlueBubbles connector HTTP routes.
 *
 * Implements the shared setup contract defined in
 * `@elizaos/app-core/api/setup-contract.ts`:
 *
 *   GET  /api/setup/bluebubbles/status   service health + webhook path
 *   POST /api/setup/bluebubbles/start    save server URL + password and reconnect
 *   POST /api/setup/bluebubbles/cancel   clear stored credentials
 *
 * BlueBubbles is webhook-driven: there is no QR-pairing flow, so `start`
 * accepts the server URL and password and persists them through the
 * connector-setup service; `cancel` wipes those credentials.
 *
 * Post-setup data routes live under `/api/bluebubbles/` (chats, messages)
 * and the webhook receiver stays put at `/webhooks/bluebubbles` since it's
 * called by the BlueBubbles server, not by the UI setup flow.
 *
 * The webhook path is read from `service.getWebhookPath()`. We register a
 * route at the default `/webhooks/bluebubbles` path; if the service is
 * configured to use a different path, that path is exposed via the runtime
 * plugin route system through the same handler — but we keep the default
 * here since the runtime route table is keyed by the path string.
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

// ── Setup contract types (mirror @elizaos/app-core/api/setup-contract) ──

type SetupState = "idle" | "configuring" | "paired" | "error";

interface SetupStatusResponse<TDetail = unknown> {
	connector: string;
	state: SetupState;
	detail?: TDetail;
}

interface SetupErrorResponse {
	error: { code: string; message: string };
}

function setupError(code: string, message: string): SetupErrorResponse {
	return { error: { code, message } };
}

// ── BlueBubbles types ───────────────────────────────────────────────────

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

interface ConnectorSetupService {
	getConfig(): Record<string, unknown>;
	persistConfig(config: Record<string, unknown>): void;
	updateConfig(updater: (config: Record<string, unknown>) => void): void;
}

function isConnectorSetupService(
	service: unknown,
): service is ConnectorSetupService {
	if (!service || typeof service !== "object") return false;
	const candidate = service as Partial<ConnectorSetupService>;
	return (
		typeof candidate.getConfig === "function" &&
		typeof candidate.persistConfig === "function" &&
		typeof candidate.updateConfig === "function"
	);
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
	const service = runtime.getService("connector-setup");
	return isConnectorSetupService(service) ? service : null;
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

interface BlueBubblesSetupDetail {
	available: boolean;
	connected: boolean;
	webhookPath: string;
	reason?: string;
}

function buildStatusResponse(
	runtime: IAgentRuntime,
): SetupStatusResponse<BlueBubblesSetupDetail> {
	const service = resolveService(runtime);
	const webhookPath = resolveBlueBubblesWebhookPath(runtime);
	if (!service) {
		return {
			connector: "bluebubbles",
			state: "idle",
			detail: {
				available: false,
				connected: false,
				webhookPath,
				reason: "bluebubbles service not registered",
			},
		};
	}
	const connected = service.isConnected();
	return {
		connector: "bluebubbles",
		state: connected ? "paired" : "configuring",
		detail: {
			available: true,
			connected,
			webhookPath,
		},
	};
}

// ── GET /api/setup/bluebubbles/status ───────────────────────────────────

async function handleStatus(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	res.status(200).json(buildStatusResponse(runtime));
}

// ── POST /api/setup/bluebubbles/start ───────────────────────────────────

async function handleStart(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const body = (req.body ?? {}) as {
		serverUrl?: unknown;
		password?: unknown;
	};

	const serverUrlRaw = body.serverUrl;
	const passwordRaw = body.password;
	const serverUrl = typeof serverUrlRaw === "string" ? serverUrlRaw.trim() : "";
	const password = typeof passwordRaw === "string" ? passwordRaw : "";

	if (!serverUrl || !password) {
		res
			.status(400)
			.json(
				setupError(
					"bad_request",
					"serverUrl and password are required to start BlueBubbles setup",
				),
			);
		return;
	}

	try {
		// eslint-disable-next-line no-new -- validation only; throws on invalid URL
		new URL(serverUrl);
	} catch {
		res
			.status(400)
			.json(setupError("bad_request", "serverUrl must be a valid URL"));
		return;
	}

	const setupService = getSetupService(runtime);
	if (!setupService) {
		res
			.status(503)
			.json(
				setupError(
					"service_unavailable",
					"connector-setup service not registered",
				),
			);
		return;
	}

	setupService.updateConfig((cfg) => {
		if (!cfg.connectors) cfg.connectors = {};
		const connectors = cfg.connectors as Record<string, unknown>;
		const previous =
			(connectors.bluebubbles as Record<string, unknown> | undefined) ?? {};
		connectors.bluebubbles = {
			...previous,
			serverUrl,
			password,
			enabled: true,
		};
	});

	res.status(200).json(buildStatusResponse(runtime));
}

// ── POST /api/setup/bluebubbles/cancel ──────────────────────────────────

async function handleCancel(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const setupService = getSetupService(runtime);
	if (!setupService) {
		res
			.status(503)
			.json(
				setupError(
					"service_unavailable",
					"connector-setup service not registered",
				),
			);
		return;
	}

	setupService.updateConfig((cfg) => {
		const connectors = (cfg.connectors ?? {}) as Record<string, unknown>;
		delete connectors.bluebubbles;
	});

	res.status(200).json({
		connector: "bluebubbles",
		state: "idle",
	} satisfies SetupStatusResponse<undefined>);
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

/**
 * Plugin routes for BlueBubbles.
 * Registered with `rawPath: true` to mount at canonical paths.
 *
 * The setup-shaped routes live under `/api/setup/bluebubbles/`. Post-setup
 * data routes (chats, messages) remain under `/api/bluebubbles/`. The
 * webhook stays at `/webhooks/bluebubbles` and is registered as a public
 * route (no auth required) since the BlueBubbles server posts to it from
 * outside the loopback API.
 */
export const blueBubblesSetupRoutes: Route[] = [
	{
		type: "GET",
		path: "/api/setup/bluebubbles/status",
		handler: handleStatus,
		rawPath: true,
	},
	{
		type: "POST",
		path: "/api/setup/bluebubbles/start",
		handler: handleStart,
		rawPath: true,
	},
	{
		type: "POST",
		path: "/api/setup/bluebubbles/cancel",
		handler: handleCancel,
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
