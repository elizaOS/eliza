/**
 * Discord local setup HTTP routes.
 *
 * Provides status, authorization, and subscription management for the
 * Discord local IPC connector:
 *
 *   GET  /api/discord-local/status          connection + auth status
 *   POST /api/discord-local/authorize       start OAuth authorize flow
 *   POST /api/discord-local/disconnect      tear down session
 *   GET  /api/discord-local/guilds          list guilds (requires auth)
 *   GET  /api/discord-local/channels        list channels for a guild
 *   POST /api/discord-local/subscriptions   subscribe to channel messages
 *
 * These routes are registered with `rawPath: true` so they mount at their
 * legacy paths without the plugin-name prefix.
 */

import type {
	IAgentRuntime,
	Route,
	RouteRequest,
	RouteResponse,
} from "@elizaos/core";
import { DISCORD_LOCAL_SERVICE_NAME } from "./discord-local-service";

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
	if (!service || typeof service !== "object") {
		return false;
	}

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
	if (!service || typeof service !== "object") {
		return false;
	}

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

// ── GET /api/discord-local/status ──────────────────────────────────
function getUnregisteredStatus() {
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

async function handleStatus(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	res.status(200).json(service ? service.getStatus() : getUnregisteredStatus());
}

// ── POST /api/discord-local/authorize ──────────────────────────────
async function handleAuthorize(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res.status(503).json({ error: "discord-local service not registered" });
		return;
	}
	try {
		res.status(200).json(await service.authorize());
	} catch (error) {
		res.status(500).json({
			error: `failed to authorize discord-local: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

// ── POST /api/discord-local/disconnect ─────────────────────────────
async function handleDisconnect(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res.status(503).json({ error: "discord-local service not registered" });
		return;
	}
	try {
		await service.disconnectSession();
		res.status(200).json({ ok: true });
	} catch (error) {
		res.status(500).json({
			error: `failed to disconnect discord-local: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

// ── GET /api/discord-local/guilds ──────────────────────────────────
async function handleGuilds(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res.status(503).json({ error: "discord-local service not registered" });
		return;
	}
	try {
		const guilds = await service.listGuilds();
		res.status(200).json({ guilds, count: guilds.length });
	} catch (error) {
		res.status(500).json({
			error: `failed to list discord-local guilds: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

// ── GET /api/discord-local/channels ────────────────────────────────
async function handleChannels(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res.status(503).json({ error: "discord-local service not registered" });
		return;
	}

	const url = new URL(
		(req as { url?: string }).url ?? "/api/discord-local/channels",
		"http://localhost",
	);
	const guildId = url.searchParams.get("guildId")?.trim() ?? "";
	if (!guildId) {
		res.status(400).json({ error: "guildId is required" });
		return;
	}

	try {
		const channels = await service.listChannels(guildId);
		res.status(200).json({ channels, count: channels.length });
	} catch (error) {
		res.status(500).json({
			error: `failed to list discord-local channels: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

// ── POST /api/discord-local/subscriptions ──────────────────────────
async function handleSubscriptions(
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = resolveService(runtime);
	if (!service) {
		res.status(503).json({ error: "discord-local service not registered" });
		return;
	}

	const body = (req.body as { channelIds?: string[] } | null) ?? null;
	if (!body) {
		res.status(400).json({ error: "request body is required" });
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
	} catch (error) {
		res.status(500).json({
			error: `failed to update discord-local subscriptions: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

/**
 * Plugin routes for Discord local setup.
 * Registered with `rawPath: true` to preserve legacy `/api/discord-local/*` paths.
 */
export const discordSetupRoutes: Route[] = [
	{
		type: "GET",
		path: "/api/discord-local/status",
		handler: handleStatus,
		rawPath: true,
	},
	{
		type: "POST",
		path: "/api/discord-local/authorize",
		handler: handleAuthorize,
		rawPath: true,
	},
	{
		type: "POST",
		path: "/api/discord-local/disconnect",
		handler: handleDisconnect,
		rawPath: true,
	},
	{
		type: "GET",
		path: "/api/discord-local/guilds",
		handler: handleGuilds,
		rawPath: true,
	},
	{
		type: "GET",
		path: "/api/discord-local/channels",
		handler: handleChannels,
		rawPath: true,
	},
	{
		type: "POST",
		path: "/api/discord-local/subscriptions",
		handler: handleSubscriptions,
		rawPath: true,
	},
];
