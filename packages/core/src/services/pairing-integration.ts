/**
 * Pairing Integration Helpers
 *
 * Utility functions for integrating the PairingService with channel plugins.
 * This provides a consistent interface for handling the pairing workflow
 * across different messaging platforms.
 */

import type { IAgentRuntime } from "../types";
import type { PairingChannel } from "../types/pairing";
import { getPairingIdLabel } from "../types/pairing";
import { ServiceType } from "../types/service";
import type { PairingService } from "./pairing";

/**
 * Result of a pairing check
 */
export interface PairingCheckResult {
	/** Whether the sender is allowed to proceed */
	allowed: boolean;
	/** If not allowed, the pairing code (if a new request was created) */
	pairingCode?: string;
	/** Whether a new pairing request was created */
	newRequest?: boolean;
	/** Human-readable message to send to the user */
	replyMessage?: string;
	/** The ID label for this channel (e.g., "phoneNumber", "userId") */
	idLabel?: string;
}

/**
 * Parameters for checking pairing
 */
export interface PairingCheckParams {
	/** The messaging channel (telegram, discord, whatsapp, etc.) */
	channel: PairingChannel;
	/** User identifier on the channel */
	senderId: string;
	/** Optional metadata about the requester (e.g., name, username) */
	metadata?: Record<string, string>;
	/** Whether to suppress sending a pairing reply (e.g., for historical messages) */
	suppressReply?: boolean;
}

/**
 * Get the PairingService from the runtime, or null if not available.
 */
export async function getPairingService(
	runtime: IAgentRuntime,
): Promise<PairingService | null> {
	try {
		return runtime.getService(ServiceType.PAIRING) as PairingService | null;
	} catch {
		return null;
	}
}

/**
 * Check if a sender is allowed based on the pairing policy.
 *
 * This function implements the core pairing workflow:
 * 1. Check if the sender is already in the allowlist -> allowed
 * 2. If not, create or update a pairing request
 * 3. Return the pairing code and reply message
 *
 * @example
 * ```typescript
 * const result = await checkPairingAllowed(runtime, {
 *   channel: "whatsapp",
 *   senderId: "+14155551234",
 *   metadata: { name: "John Doe" },
 * });
 *
 * if (!result.allowed) {
 *   if (result.replyMessage) {
 *     await sendMessage(result.replyMessage);
 *   }
 *   return; // Block the message
 * }
 * // Process the message...
 * ```
 */
export async function checkPairingAllowed(
	runtime: IAgentRuntime,
	params: PairingCheckParams,
): Promise<PairingCheckResult> {
	const { channel, senderId, metadata, suppressReply } = params;

	const pairingService = await getPairingService(runtime);
	if (!pairingService) {
		// No pairing service available - allow by default (fallback behavior)
		runtime.logger.warn(
			{ src: "pairing-integration", channel },
			"PairingService not available, allowing message by default",
		);
		return { allowed: true };
	}

	// Check if already in allowlist
	const isAllowed = await pairingService.isAllowed(channel, senderId);
	if (isAllowed) {
		return { allowed: true };
	}

	// Not allowed - create or update pairing request
	if (suppressReply) {
		return { allowed: false };
	}

	const { code, created } = await pairingService.upsertRequest({
		channel,
		senderId,
		metadata,
	});

	// Build the reply message
	const idLabel = getPairingIdLabel(channel);
	const replyMessage = buildPairingReplyMessage({
		channel,
		senderId,
		code,
		idLabel,
	});

	return {
		allowed: false,
		pairingCode: code,
		newRequest: created,
		replyMessage: created ? replyMessage : undefined,
		idLabel,
	};
}

/**
 * Build the pairing reply message sent to unauthorized users.
 */
export function buildPairingReplyMessage(params: {
	channel: PairingChannel;
	senderId: string;
	code: string;
	idLabel?: string;
}): string {
	const { channel, senderId, code, idLabel = "userId" } = params;

	const lines = [
		"Access not configured.",
		"",
		`Your ${idLabel}: ${senderId}`,
		"",
		`Pairing code: ${code}`,
		"",
		"Ask the bot owner to approve with:",
		`  pairing approve ${channel} ${code}`,
	];

	return lines.join("\n");
}

/**
 * Directly add a sender to the allowlist (bypass pairing).
 * Useful for CLI commands or admin actions.
 */
export async function addToAllowlist(
	runtime: IAgentRuntime,
	channel: PairingChannel,
	senderId: string,
	metadata?: Record<string, string>,
): Promise<boolean> {
	const pairingService = await getPairingService(runtime);
	if (!pairingService) {
		runtime.logger.warn(
			{ src: "pairing-integration", channel },
			"PairingService not available",
		);
		return false;
	}

	await pairingService.addToAllowlist(channel, senderId, metadata);
	return true;
}

/**
 * Remove a sender from the allowlist.
 */
export async function removeFromAllowlist(
	runtime: IAgentRuntime,
	channel: PairingChannel,
	senderId: string,
): Promise<boolean> {
	const pairingService = await getPairingService(runtime);
	if (!pairingService) {
		return false;
	}

	return pairingService.removeFromAllowlist(channel, senderId);
}

/**
 * Check if a sender is in the allowlist.
 */
export async function isInAllowlist(
	runtime: IAgentRuntime,
	channel: PairingChannel,
	senderId: string,
): Promise<boolean> {
	const pairingService = await getPairingService(runtime);
	if (!pairingService) {
		return false;
	}

	return pairingService.isAllowed(channel, senderId);
}

/**
 * Approve a pairing code and add the sender to the allowlist.
 * Returns the approved sender ID or null if the code was not found.
 */
export async function approvePairingCode(
	runtime: IAgentRuntime,
	channel: PairingChannel,
	code: string,
): Promise<string | null> {
	const pairingService = await getPairingService(runtime);
	if (!pairingService) {
		return null;
	}

	const result = await pairingService.approveCode({ channel, code });
	return result?.senderId ?? null;
}
