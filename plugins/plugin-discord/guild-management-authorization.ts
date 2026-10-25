/**
 * Binds Discord structural management to an exact persisted guild world and
 * revalidates requester authority at the connector mutation boundary. Guild
 * names and live cache enumeration never participate in authorization.
 */

import {
	authorizeManageServerDestination,
	createUniqueUuid,
	ElizaError,
	type IAgentRuntime,
	type MessageConnectorManageServerAuthorization,
	type MessageConnectorManageServerDestination,
	stringToUuid,
	type TargetInfo,
} from "@elizaos/core";

const DISCORD_SNOWFLAKE_PATTERN = /^\d{15,20}$/;

function authorizationError(
	code: string,
	message: string,
	context: Record<string, unknown>,
): never {
	throw new ElizaError(message, { code, context });
}

/** Resolve only an exact Discord snowflake into its deterministic durable ids. */
export function resolveDiscordManageServerDestination(
	runtime: IAgentRuntime,
	params: { target?: TargetInfo; serverId: string },
	accountId: string,
): MessageConnectorManageServerDestination {
	const serverId = params.serverId.trim();
	if (!DISCORD_SNOWFLAKE_PATTERN.test(serverId)) {
		authorizationError(
			"DISCORD_MANAGE_SERVER_ID_REQUIRED",
			"Discord server management requires an exact guild snowflake; display names are not authorized.",
			{ accountId },
		);
	}
	if (params.target?.source && params.target.source !== "discord") {
		authorizationError(
			"DISCORD_MANAGE_SERVER_SOURCE_MISMATCH",
			"Discord server management received a target from another connector source.",
			{ accountId, targetSource: params.target.source },
		);
	}
	if (params.target?.accountId && params.target.accountId !== accountId) {
		authorizationError(
			"DISCORD_MANAGE_SERVER_ACCOUNT_MISMATCH",
			"Discord server management target account does not match the selected connector account.",
			{ accountId, targetAccountId: params.target.accountId },
		);
	}
	if (params.target?.serverId && params.target.serverId !== serverId) {
		authorizationError(
			"DISCORD_MANAGE_SERVER_BINDING_MISMATCH",
			"Discord server management target does not match the requested guild.",
			{ accountId, serverId },
		);
	}

	return {
		source: "discord",
		accountId,
		serverId,
		messageServerId: stringToUuid(serverId),
		destinationWorldId: createUniqueUuid(runtime, serverId),
		target: {
			...params.target,
			source: "discord",
			accountId,
			serverId,
		},
	};
}

/**
 * Check that core's provenance still names this exact guild/account, then
 * repeat the durable binding, verified-cluster membership, and ADMIN+ checks.
 */
export async function revalidateDiscordManageServerAuthorization(
	runtime: IAgentRuntime,
	authorization: MessageConnectorManageServerAuthorization,
	accountId: string,
	guildId: string,
): Promise<MessageConnectorManageServerAuthorization> {
	if (
		authorization.source !== "discord" ||
		authorization.accountId !== accountId ||
		authorization.target.source !== "discord" ||
		authorization.target.accountId !== accountId ||
		authorization.serverId !== guildId ||
		authorization.target.serverId !== guildId
	) {
		authorizationError(
			"DISCORD_MANAGE_SERVER_PROVENANCE_MISMATCH",
			"Discord server management authorization does not match the live mutation destination.",
			{ accountId, guildId },
		);
	}
	const expected = resolveDiscordManageServerDestination(
		runtime,
		{ target: authorization.target, serverId: guildId },
		accountId,
	);
	if (
		authorization.source !== expected.source ||
		authorization.accountId !== expected.accountId ||
		authorization.serverId !== expected.serverId ||
		authorization.messageServerId !== expected.messageServerId ||
		authorization.destinationWorldId !== expected.destinationWorldId
	) {
		authorizationError(
			"DISCORD_MANAGE_SERVER_PROVENANCE_MISMATCH",
			"Discord server management authorization does not match the live mutation destination.",
			{ accountId, guildId },
		);
	}

	return authorizeManageServerDestination(
		runtime,
		authorization.requesterEntityId,
		expected,
	);
}
