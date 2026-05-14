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
 * Post-setup data routes (guilds, channels, subscriptions) live in
 * `./data-routes.ts` under `/api/discord/` — they're invoked after the
 * connector is authorized to drive the channel-picker UI, so they are
 * not part of the setup state machine.
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

function resolveService(
	runtime: IAgentRuntime,
): DiscordLocalServiceLike | null {
	const raw = runtime.getService(DISCORD_LOCAL_SERVICE_NAME);
	return isDiscordLocalServiceLike(raw) ? raw : null;
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

/**
 * Plugin routes for Discord local setup.
 *
 * Setup-shaped endpoints live under `/api/setup/discord/`. Post-setup
 * data fetches (guilds, channels, subscriptions) live in
 * `./data-routes.ts` under `/api/discord/`.
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
];
