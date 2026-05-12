/**
 * Discord local connector setup HTTP routes.
 *
 * Implements the shared setup contract defined in
 * `@elizaos/app-core/api/setup-contract.ts`:
 *
 *   GET  /api/setup/discord/status   connection + auth status
 *   POST /api/setup/discord/start    start OAuth authorize flow
 *   POST /api/setup/discord/cancel   tear down session and clear config
 *
 * Post-setup data routes (guilds, channels, subscriptions) live under
 * `/api/discord/` — they're invoked after the connector is authorized to
 * drive the channel-picker UI, so they are not part of the setup state
 * machine.
 *
 * These routes are registered with `rawPath: true` so they mount at their
 * canonical paths without the plugin-name prefix.
 */

import type {
	IAgentRuntime,
	Route,
	RouteRequest,
	RouteResponse,
} from "@elizaos/core";
import { DISCORD_LOCAL_SERVICE_NAME } from "./discord-local-service";

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

// ── Discord types ───────────────────────────────────────────────────────

interface DiscordLocalServiceLike {
	getStatus(): Record<string, unknown>;
	authorize(): Promise<Record<string, unknown>>;
	disconnectSession(): Promise<void>;
	listGuilds(): Promise<Array<Record<string, unknown>>>;
	listChannels(guildId: string): Promise<Array<Record<string, unknown>>>;
	subscribeChannelMessages(channelIds: string[]): Promise<string[]>;
}

/**
 * Minimal interface for the connector-setup service exposed by the agent.
 * Plugins access it via `runtime.getService("connector-setup")`.
 */
interface ConnectorSetupService {
	getConfig(): Record<string, unknown>;
	persistConfig(config: Record<string, unknown>): void;
	updateConfig(updater: (config: Record<string, unknown>) => void): void;
	registerEscalationChannel(channelName: string): boolean;
	setOwnerContact(update: {
		source: string;
		channelId?: string;
		entityId?: string;
		roomId?: string;
	}): boolean;
}

interface ConnectorConfig {
	enabled?: boolean;
	messageChannelIds?: string[];
	[key: string]: unknown;
}

function isConnectorSetupService(
	service: unknown,
): service is ConnectorSetupService {
	if (!service || typeof service !== "object") return false;
	const candidate = service as Record<string, unknown>;
	return (
		typeof candidate.getConfig === "function" &&
		typeof candidate.persistConfig === "function" &&
		typeof candidate.updateConfig === "function" &&
		typeof candidate.registerEscalationChannel === "function" &&
		typeof candidate.setOwnerContact === "function"
	);
}

function isDiscordLocalServiceLike(
	service: unknown,
): service is DiscordLocalServiceLike {
	if (!service || typeof service !== "object") return false;
	const candidate = service as Record<string, unknown>;
	return (
		typeof candidate.getStatus === "function" &&
		typeof candidate.authorize === "function" &&
		typeof candidate.disconnectSession === "function" &&
		typeof candidate.listGuilds === "function" &&
		typeof candidate.listChannels === "function" &&
		typeof candidate.subscribeChannelMessages === "function"
	);
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
	const service = runtime.getService("connector-setup");
	return isConnectorSetupService(service) ? service : null;
}

function resolveService(
	runtime: IAgentRuntime,
): DiscordLocalServiceLike | null {
	const raw = runtime.getService(DISCORD_LOCAL_SERVICE_NAME);
	return isDiscordLocalServiceLike(raw) ? raw : null;
}

function getConnectorConfig(
	setupService: ConnectorSetupService,
): ConnectorConfig {
	const config = setupService.getConfig();
	const connectors =
		(config.connectors as Record<string, ConnectorConfig> | undefined) ??
		((config as Record<string, unknown>).channels as
			| Record<string, ConnectorConfig>
			| undefined) ??
		{};

	const current = connectors.discordLocal;
	if (current && typeof current === "object" && !Array.isArray(current)) {
		return current as ConnectorConfig;
	}
	return {};
}

interface DiscordServiceStatusShape {
	available: boolean;
	connected: boolean;
	authenticated: boolean;
	currentUser?: unknown;
	subscribedChannelIds: string[];
	configuredChannelIds: string[];
	scopes: string[];
	lastError: string | null;
	ipcPath: string | null;
	reason?: string;
}

function getUnregisteredDetail(): DiscordServiceStatusShape {
	return {
		available: false,
		connected: false,
		authenticated: false,
		currentUser: null,
		subscribedChannelIds: [],
		configuredChannelIds: [],
		scopes: [],
		lastError: "discord-local service not registered",
		ipcPath: null,
		reason: "discord-local service not registered",
	};
}

function buildStatusResponse(
	runtime: IAgentRuntime,
): SetupStatusResponse<DiscordServiceStatusShape> {
	const service = resolveService(runtime);
	if (!service) {
		return {
			connector: "discord",
			state: "idle",
			detail: getUnregisteredDetail(),
		};
	}
	const detail = service.getStatus() as unknown as DiscordServiceStatusShape;
	const state: SetupState = detail.authenticated
		? "paired"
		: detail.lastError
			? "error"
			: detail.connected
				? "configuring"
				: "idle";
	return {
		connector: "discord",
		state,
		detail,
	};
}

// ── GET /api/setup/discord/status ───────────────────────────────────────

async function handleStatus(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	res.status(200).json(buildStatusResponse(runtime));
}

// ── POST /api/setup/discord/start ───────────────────────────────────────

async function handleStart(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res
			.status(503)
			.json(
				setupError(
					"service_unavailable",
					"discord-local service not registered",
				),
			);
		return;
	}
	try {
		const detail =
			(await service.authorize()) as unknown as DiscordServiceStatusShape;
		const state: SetupState = detail.authenticated
			? "paired"
			: detail.lastError
				? "error"
				: "configuring";
		res.status(200).json({
			connector: "discord",
			state,
			detail,
		} satisfies SetupStatusResponse<DiscordServiceStatusShape>);
	} catch (err) {
		res
			.status(500)
			.json(
				setupError(
					"internal_error",
					`failed to authorize discord-local: ${err instanceof Error ? err.message : String(err)}`,
				),
			);
	}
}

// ── POST /api/setup/discord/cancel ──────────────────────────────────────

async function handleCancel(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res
			.status(503)
			.json(
				setupError(
					"service_unavailable",
					"discord-local service not registered",
				),
			);
		return;
	}
	try {
		await service.disconnectSession();
		res.status(200).json({
			connector: "discord",
			state: "idle",
		} satisfies SetupStatusResponse<undefined>);
	} catch (err) {
		res
			.status(500)
			.json(
				setupError(
					"internal_error",
					`failed to disconnect discord-local: ${err instanceof Error ? err.message : String(err)}`,
				),
			);
	}
}

// ── GET /api/discord/guilds ─────────────────────────────────────────────

async function handleGuilds(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res
			.status(503)
			.json(
				setupError(
					"service_unavailable",
					"discord-local service not registered",
				),
			);
		return;
	}
	try {
		const guilds = await service.listGuilds();
		res.status(200).json({ guilds, count: guilds.length });
	} catch (err) {
		res
			.status(500)
			.json(
				setupError(
					"internal_error",
					`failed to list discord-local guilds: ${err instanceof Error ? err.message : String(err)}`,
				),
			);
	}
}

// ── GET /api/discord/channels ───────────────────────────────────────────

async function handleChannels(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res
			.status(503)
			.json(
				setupError(
					"service_unavailable",
					"discord-local service not registered",
				),
			);
		return;
	}

	const url = new URL(
		(req as { url?: string }).url ?? "/api/discord/channels",
		"http://localhost",
	);
	const guildId = url.searchParams.get("guildId")?.trim() ?? "";
	if (!guildId) {
		res.status(400).json(setupError("bad_request", "guildId is required"));
		return;
	}

	try {
		const channels = await service.listChannels(guildId);
		res.status(200).json({ channels, count: channels.length });
	} catch (err) {
		res
			.status(500)
			.json(
				setupError(
					"internal_error",
					`failed to list discord-local channels: ${err instanceof Error ? err.message : String(err)}`,
				),
			);
	}
}

// ── POST /api/discord/subscriptions ─────────────────────────────────────

async function handleSubscriptions(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res
			.status(503)
			.json(
				setupError(
					"service_unavailable",
					"discord-local service not registered",
				),
			);
		return;
	}

	const body = (req.body as { channelIds?: string[] } | null) ?? null;
	if (!body) {
		res.status(400).json(setupError("bad_request", "request body is required"));
		return;
	}

	const channelIds = Array.isArray(body.channelIds)
		? Array.from(
				new Set(
					body.channelIds
						.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
						.filter((entry) => entry.length > 0),
				),
			)
		: [];

	try {
		const subscribedChannelIds =
			await service.subscribeChannelMessages(channelIds);

		const setupService = getSetupService(runtime);
		if (setupService) {
			const connectorConfig = getConnectorConfig(setupService);
			setupService.updateConfig((config) => {
				if (!config.connectors) {
					config.connectors = {};
				}
				(config.connectors as Record<string, ConnectorConfig>).discordLocal = {
					...connectorConfig,
					enabled: connectorConfig.enabled !== false,
					messageChannelIds: subscribedChannelIds,
				};
			});

			// Auto-populate owner contact so LifeOps can deliver reminders
			if (subscribedChannelIds.length > 0) {
				setupService.setOwnerContact({
					source: "discord",
					channelId: subscribedChannelIds[0],
				});
				// Add Discord to the escalation channel list so it is reachable
				// without the user explicitly configuring escalation.
				setupService.registerEscalationChannel("discord");
			}
		}

		res.status(200).json({ subscribedChannelIds });
	} catch (err) {
		res
			.status(500)
			.json(
				setupError(
					"internal_error",
					`failed to update discord-local subscriptions: ${err instanceof Error ? err.message : String(err)}`,
				),
			);
	}
}

/**
 * Plugin routes for Discord local setup + post-setup data fetches.
 *
 * Setup-shaped endpoints live under `/api/setup/discord/`. Post-setup
 * data fetches (guilds, channels, subscriptions) live under
 * `/api/discord/` — they're invoked after authorization to drive the
 * channel-picker UI, so they are not part of the setup state machine.
 */
export const discordSetupRoutes: Route[] = [
	{
		type: "GET",
		path: "/api/setup/discord/status",
		handler: handleStatus,
		rawPath: true,
	},
	{
		type: "POST",
		path: "/api/setup/discord/start",
		handler: handleStart,
		rawPath: true,
	},
	{
		type: "POST",
		path: "/api/setup/discord/cancel",
		handler: handleCancel,
		rawPath: true,
	},
	{
		type: "GET",
		path: "/api/discord/guilds",
		handler: handleGuilds,
		rawPath: true,
	},
	{
		type: "GET",
		path: "/api/discord/channels",
		handler: handleChannels,
		rawPath: true,
	},
	{
		type: "POST",
		path: "/api/discord/subscriptions",
		handler: handleSubscriptions,
		rawPath: true,
	},
];
