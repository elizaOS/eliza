/**
 * DiscordOwnerPairingService
 *
 * Implements the connector side of the owner-pairing flow for Discord:
 *   - `/eliza-pair <code>` slash command: relays a 6-digit pair code to the
 *     backend `verifyOwnerBindFromConnector` service and reports the result.
 *   - `sendOwnerLoginDmLink({ externalId, link })`: called by the backend's
 *     `/api/auth/login/owner/dm-link/request` handler to DM a login link to
 *     the Discord user identified by their snowflake ID.
 *
 * Hard rules:
 *   - Backend is the authority. The connector only relays; it never decides
 *     whether a binding succeeds.
 *   - Fail closed: if the backend service is unreachable, we reply with an
 *     explicit error message and do NOT silently succeed.
 *   - Per-user rate limit on `/eliza-pair` invocations: 5 attempts per minute.
 *   - DM-link sender never pre-fetches or auto-redeems the link.
 *   - Webhook signature verification: Discord slash-command payloads are
 *     verified by discord.js before reaching this handler (the library handles
 *     it for gateway-connected bots). No additional verification needed here.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type { ChatInputCommandInteraction } from "discord.js";
import { addCommand } from "./slash-commands";

/** Service type string used by the backend to look up this service. */
export const DISCORD_OWNER_PAIRING_SERVICE_TYPE = "OWNER_PAIRING_DISCORD";

/** Maximum pairing attempts per user per window. */
const RATE_LIMIT_MAX_ATTEMPTS = 5;
/** Window length in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Shape of the backend `verifyOwnerBindFromConnector` service method.
 * The backend owns this interface; we look it up via the runtime service
 * registry. If it is absent, we fail closed.
 */
interface OwnerBindVerifyService {
	verifyOwnerBindFromConnector(params: {
		connector: "discord" | "telegram" | "wechat" | "matrix";
		externalId: string;
		displayHandle: string;
		code: string;
	}): Promise<{ success: boolean; error?: string }>;
}

/** Audit-emit helper — best-effort, never throws. */
async function auditEmit(
	runtime: IAgentRuntime,
	action: string,
	outcome: "success" | "failure",
	metadata: Record<string, string | number | boolean>,
): Promise<void> {
	try {
		await runtime.emitEvent(
			["AUTH_AUDIT"] as string[],
			{
				runtime,
				action,
				outcome,
				metadata,
				source: "discord",
			} as never,
		);
	} catch {
		// Audit is best-effort; a failure here must not mask the real result.
	}
}

/**
 * In-memory per-user rate-limit state.
 * Key: Discord user snowflake ID.
 * Value: list of attempt timestamps within the current window.
 */
const pairAttempts = new Map<string, number[]>();

/**
 * Clears all in-memory rate-limit state. Exposed for testing only.
 * @internal
 */
export function _resetRateLimitStateForTesting(): void {
	pairAttempts.clear();
}

function isRateLimited(userId: string): boolean {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT_WINDOW_MS;
	const attempts = (pairAttempts.get(userId) ?? []).filter(
		(ts) => ts > windowStart,
	);
	pairAttempts.set(userId, attempts);
	if (attempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
		return true;
	}
	attempts.push(now);
	pairAttempts.set(userId, attempts);
	return false;
}

/**
 * Validates that the supplied string is a 6-digit numeric pair code.
 * The backend performs its own authoritative validation; this is a
 * pre-flight check to avoid a round-trip for obviously invalid inputs.
 */
function isValidPairCode(code: string): boolean {
	return /^\d{6}$/.test(code.trim());
}

/**
 * Looks up the backend verify service from the runtime service registry.
 * Returns null when the backend has not yet registered it.
 */
function resolveVerifyService(
	runtime: IAgentRuntime,
): OwnerBindVerifyService | null {
	try {
		const svc = runtime.getService("OWNER_BIND_VERIFY") as unknown;
		if (
			svc &&
			typeof svc === "object" &&
			typeof (svc as Record<string, unknown>).verifyOwnerBindFromConnector ===
				"function"
		) {
			return svc as OwnerBindVerifyService;
		}
	} catch {
		// Service not registered yet.
	}
	return null;
}

/**
 * Handler for the `/eliza-pair <code>` slash command.
 * Called by the Discord slash-command dispatcher after it has already
 * applied cooldown and role checks. Exported for unit testing.
 */
export async function handleElizaPairCommand(
	interaction: ChatInputCommandInteraction,
	runtime: IAgentRuntime,
): Promise<void> {
	const userId = interaction.user.id;
	const displayHandle =
		interaction.user.discriminator && interaction.user.discriminator !== "0"
			? `${interaction.user.username}#${interaction.user.discriminator}`
			: interaction.user.username;

	// Per-user rate limit enforced at the connector layer to reduce log spam.
	if (isRateLimited(userId)) {
		logger.warn(
			{ src: "plugin:discord:owner-pairing", userId },
			"Rate limit hit for /eliza-pair",
		);
		await auditEmit(
			runtime,
			"auth.owner.pair.discord.rate_limited",
			"failure",
			{
				externalId: userId,
			},
		);
		await interaction.reply({
			content:
				"Too many pairing attempts. Please wait a moment before trying again.",
			ephemeral: true,
		});
		return;
	}

	const rawCode = interaction.options.getString("code");
	if (!rawCode?.trim()) {
		await interaction.reply({
			content:
				"Usage: `/eliza-pair <code>` — enter the 6-digit code shown in the Eliza dashboard.",
			ephemeral: true,
		});
		return;
	}

	const code = rawCode.trim();
	if (!isValidPairCode(code)) {
		await interaction.reply({
			content:
				"The pairing code must be exactly 6 digits. Check the Eliza dashboard and try again.",
			ephemeral: true,
		});
		return;
	}

	const verifySvc = resolveVerifyService(runtime);
	if (!verifySvc) {
		logger.error(
			{ src: "plugin:discord:owner-pairing", userId },
			"OWNER_BIND_VERIFY service not available — cannot complete pairing",
		);
		await auditEmit(
			runtime,
			"auth.owner.pair.discord.service_unavailable",
			"failure",
			{ externalId: userId },
		);
		await interaction.reply({
			content:
				"Eliza could not reach the pairing service right now. Please try again in a moment.",
			ephemeral: true,
		});
		return;
	}

	let result: { success: boolean; error?: string };
	try {
		result = await verifySvc.verifyOwnerBindFromConnector({
			connector: "discord",
			externalId: userId,
			displayHandle,
			code,
		});
	} catch (err) {
		logger.error(
			{
				src: "plugin:discord:owner-pairing",
				userId,
				error: err instanceof Error ? err.message : String(err),
			},
			"verifyOwnerBindFromConnector threw unexpectedly",
		);
		await auditEmit(
			runtime,
			"auth.owner.pair.discord.verify_error",
			"failure",
			{ externalId: userId },
		);
		await interaction.reply({
			content:
				"Something went wrong while verifying the pairing code. Please try again.",
			ephemeral: true,
		});
		return;
	}

	if (result.success) {
		logger.info(
			{ src: "plugin:discord:owner-pairing", userId, displayHandle },
			"Owner pairing completed successfully",
		);
		await auditEmit(runtime, "auth.owner.pair.discord.success", "success", {
			externalId: userId,
			displayHandle,
		});
		await interaction.reply({
			content: "Paired with Eliza. You can now log in via Discord.",
			ephemeral: true,
		});
	} else {
		logger.warn(
			{
				src: "plugin:discord:owner-pairing",
				userId,
				backendError: result.error,
			},
			"Owner pairing rejected by backend",
		);
		await auditEmit(runtime, "auth.owner.pair.discord.failure", "failure", {
			externalId: userId,
		});
		await interaction.reply({
			content:
				"Pair code invalid or expired. Check the Eliza dashboard for a fresh code.",
			ephemeral: true,
		});
	}
}

/**
 * Public service interface exposed via the runtime service registry.
 * The backend's `owner-binding.ts` calls `sendOwnerLoginDmLink` when the
 * user requests a DM login link via the dashboard.
 */
export interface DiscordOwnerPairingService {
	/**
	 * DMs the Discord user identified by `externalId` (a Discord snowflake)
	 * with a login link. The link is presented as-is; this method never
	 * pre-fetches or auto-redeems it.
	 *
	 * Throws if the DM cannot be delivered (user has DMs closed, bot lacks
	 * permission, Discord API error). The caller is responsible for surfacing
	 * the error to the dashboard.
	 */
	sendOwnerLoginDmLink(params: {
		externalId: string;
		link: string;
	}): Promise<void>;
}

export class DiscordOwnerPairingServiceImpl
	extends Service
	implements DiscordOwnerPairingService
{
	static serviceType = DISCORD_OWNER_PAIRING_SERVICE_TYPE;
	capabilityDescription =
		"Handles Discord-side owner pairing (slash-command code verification) and DM login-link delivery for Eliza remote auth";

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new DiscordOwnerPairingServiceImpl(runtime);
		if (resolveVerifyService(runtime)) {
			service.registerPairCommand(runtime);
			logger.info(
				{
					src: "plugin:discord:owner-pairing",
					agentId: runtime.agentId,
				},
				"DiscordOwnerPairingService started; /eliza-pair command registered",
			);
		} else {
			logger.info(
				{
					src: "plugin:discord:owner-pairing",
					agentId: runtime.agentId,
				},
				"DiscordOwnerPairingService started without /eliza-pair because OWNER_BIND_VERIFY is not registered",
			);
		}
		return service;
	}

	async stop(): Promise<void> {
		// Clear rate-limit state on shutdown to avoid stale data across restarts.
		pairAttempts.clear();
	}

	/**
	 * Registers the /eliza-pair slash command with the Discord plugin's
	 * slash-command dispatcher. Calling this multiple times is idempotent
	 * because `addCommand` overwrites existing entries by name.
	 */
	private registerPairCommand(runtime: IAgentRuntime): void {
		addCommand({
			name: "eliza-pair",
			description:
				"Pair your Discord account with Eliza using the 6-digit code from the dashboard",
			ephemeral: true,
			options: [
				{
					name: "code",
					description: "6-digit pairing code from the Eliza dashboard",
					type: "string",
					required: true,
				},
			],
			execute: async (interaction) => {
				await handleElizaPairCommand(interaction, runtime);
			},
		});
	}

	async sendOwnerLoginDmLink(params: {
		externalId: string;
		link: string;
	}): Promise<void> {
		const { externalId, link } = params;

		// Resolve the DiscordService to get the discord.js Client.
		const discordSvc = this.runtime.getService("discord") as unknown;
		const client =
			discordSvc &&
			typeof discordSvc === "object" &&
			"client" in (discordSvc as Record<string, unknown>)
				? (discordSvc as { client: unknown }).client
				: null;

		if (
			!client ||
			typeof (client as Record<string, unknown>).users !== "object"
		) {
			throw new Error(
				"Discord client is not available — cannot send DM login link",
			);
		}

		const discordClient = client as import("discord.js").Client;

		let dmChannel: import("discord.js").DMChannel;
		try {
			const user = await discordClient.users.fetch(externalId);
			dmChannel = await user.createDM();
		} catch (err) {
			throw new Error(
				`Failed to open DM channel with Discord user ${externalId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const message =
			`Click to log in to Eliza: ${link}\n\n` +
			"_This link expires in 5 minutes. Do not share it._";

		try {
			await dmChannel.send(message);
			logger.info(
				{
					src: "plugin:discord:owner-pairing",
					externalId,
				},
				"Login DM link sent",
			);
		} catch (err) {
			throw new Error(
				`Failed to send DM login link to Discord user ${externalId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
