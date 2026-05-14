/**
 * BlueBubbles connector HTTP setup routes.
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
 * Post-setup data routes (`/api/bluebubbles/chats`, `/api/bluebubbles/messages`)
 * and the public webhook receiver (`/webhooks/bluebubbles`) live in
 * `./data-routes.ts`.
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

interface BlueBubblesServiceLike {
	isConnected(): boolean;
	getWebhookPath(): string;
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

/**
 * Setup-contract routes for BlueBubbles. All routes live strictly under
 * `/api/setup/bluebubbles/`. Post-setup data routes and the webhook
 * receiver are registered separately via `blueBubblesDataRoutes`.
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
];
