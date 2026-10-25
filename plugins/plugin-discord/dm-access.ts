/**
 * Enforces the connector's single DM access policy for message and interaction
 * entrypoints so slash commands cannot bypass pairing or allowlists.
 */
import {
	checkPairingAllowed,
	getConnectorAdminWhitelist,
	type IAgentRuntime,
	isInAllowlist,
} from "@elizaos/core";
import { resolveDiscordDmPolicy } from "./environment";
import type { DiscordSettings } from "./types";

export interface DiscordDmIdentity {
	id: string;
	username: string;
	displayName?: string | null;
	discriminator?: string | null;
}

export interface DiscordDmAccessResult {
	allowed: boolean;
	replyMessage?: string;
}

export async function checkDiscordDmAccess(
	runtime: IAgentRuntime,
	settings: DiscordSettings,
	user: DiscordDmIdentity,
): Promise<DiscordDmAccessResult> {
	// Normalize at the gate: config sources (env var, character settings,
	// per-account overrides) are all plain strings at runtime, and an
	// unrecognized value must behave as `pairing`, never fall through to an
	// implicit allow.
	const policy = resolveDiscordDmPolicy(settings.dmPolicy);
	if (policy === "disabled") {
		runtime.logger.debug(
			{ src: "plugin:discord", agentId: runtime.agentId, userId: user.id },
			"DM blocked: policy is disabled",
		);
		return { allowed: false };
	}
	if (policy === "open") return { allowed: true };

	if (settings.allowFrom?.includes(user.id)) return { allowed: true };
	if (policy === "allowlist") {
		if (await isInAllowlist(runtime, "discord", user.id)) {
			return { allowed: true };
		}
		runtime.logger.debug(
			{ src: "plugin:discord", agentId: runtime.agentId, userId: user.id },
			"DM blocked: user not in allowlist",
		);
		return { allowed: false };
	}

	if (policy === "pairing") {
		const discordAdminIds = getConnectorAdminWhitelist(runtime).discord ?? [];
		if (discordAdminIds.includes(user.id)) return { allowed: true };
		const result = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: user.id,
			metadata: {
				username: user.username,
				displayName: user.displayName ?? user.username,
				discriminator: user.discriminator ?? "",
			},
		});
		if (result.allowed) return { allowed: true };
		runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: runtime.agentId,
				userId: user.id,
				pairingCode: result.pairingCode,
				newRequest: result.newRequest,
			},
			"DM blocked: pairing required",
		);
		return {
			allowed: false,
			...(result.newRequest && result.replyMessage
				? { replyMessage: result.replyMessage }
				: {}),
		};
	}

	// Unreachable for the normalized policy union; a security gate denies by
	// construction when no branch claims the sender.
	return { allowed: false };
}
