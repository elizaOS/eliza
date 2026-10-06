/**
 * Discord ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account resolution in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core`.
 *
 * Source of truth for accounts is character settings (`character.settings.discord`)
 * plus the legacy env-only DISCORD_API_TOKEN. The manager observes those via
 * `listAccounts`. `createAccount`/`patchAccount` are adapters that surface a
 * `ConnectorAccount` shape; persistent storage is delegated to the manager's
 * `ConnectorAccountStorage`. `deleteAccount` persists a disabled policy
 * (`connector-account-policy.ts`) and stops that account's gateway.
 *
 * OAuth: Discord uses bot installation (out-of-band) plus an in-app pairing
 * flow handled by `owner-pairing-service.ts`. `startOAuth` returns a Discord
 * application install URL; `completeOAuth` only reports that callback
 * completion is handled through the `/eliza-pair` slash command, not a
 * redirect.
 */

import type {
	ConnectorAccount,
	ConnectorAccountManager,
	ConnectorAccountPatch,
	ConnectorAccountProvider,
	ConnectorOAuthCallbackRequest,
	ConnectorOAuthCallbackResult,
	ConnectorOAuthStartRequest,
	ConnectorOAuthStartResult,
	IAgentRuntime,
} from "@elizaos/core";
import {
	listDiscordAccountIds,
	normalizeAccountId,
	normalizeDiscordToken,
	type ResolvedDiscordAccount,
	resolveDiscordAccount,
} from "./accounts";

import {
	isDiscordAccountDisabledByPolicy,
	persistDiscordAccountDisabled,
	readDiscordAccountPolicy,
} from "./connector-account-policy";
import type { DiscordService } from "./service";

export const DISCORD_PROVIDER_ID = "discord";

function purposeForAccount(_account: ResolvedDiscordAccount): string[] {
	return ["messaging"];
}

function accessGateForAccount(account: ResolvedDiscordAccount): string {
	const dmPolicy = account.config?.dm?.policy;
	if (dmPolicy === "pairing") {
		return "pairing";
	}
	if (dmPolicy === "disabled") {
		return "disabled";
	}
	return "open";
}

function roleForAccount(account: ResolvedDiscordAccount): "OWNER" | "AGENT" {
	// Owner-paired accounts surface as OWNER, otherwise treat the bot token
	// as the agent's own connector identity.
	const dmPolicy = account.config?.dm?.policy;
	if (dmPolicy === "pairing") {
		return "OWNER";
	}
	return "AGENT";
}

function toConnectorAccount(
	account: ResolvedDiscordAccount,
	service: DiscordService | null,
): ConnectorAccount {
	const client = service?.getClient(account.accountId);
	const connected = Boolean(
		account.enabled &&
			account.token &&
			client?.isReady() &&
			normalizeDiscordToken(client.token) === account.token,
	);
	const now = Date.now();
	return {
		id: normalizeAccountId(account.accountId),
		provider: DISCORD_PROVIDER_ID,
		label: account.name ?? account.accountId,
		role: roleForAccount(account),
		purpose: purposeForAccount(account),
		accessGate: accessGateForAccount(account),
		status:
			!account.enabled || !account.token
				? "disabled"
				: connected
					? "connected"
					: "pending",
		createdAt: now,
		updatedAt: now,
		metadata: {
			tokenSource: account.tokenSource,
			dmPolicy: account.config?.dm?.policy ?? "open",
		},
	};
}

/**
 * Builds the Discord provider for the ConnectorAccountManager. The provider's
 * lifecycle is owned by the manager; the plugin only registers it.
 */
export function createDiscordConnectorAccountProvider(
	runtime: IAgentRuntime,
): ConnectorAccountProvider {
	return {
		provider: DISCORD_PROVIDER_ID,
		label: "Discord",
		statusAuthority: "provider",
		listAccounts: async (
			_manager: ConnectorAccountManager,
		): Promise<ConnectorAccount[]> => {
			const service = runtime.getService<DiscordService>(DISCORD_PROVIDER_ID);
			const policy = await readDiscordAccountPolicy(runtime);
			return listDiscordAccountIds(runtime)
				.map((accountId) => resolveDiscordAccount(runtime, accountId))
				.filter((account) => !isDiscordAccountDisabledByPolicy(policy, account))
				.map((account) => toConnectorAccount(account, service));
		},
		createAccount: async (
			input: ConnectorAccountPatch,
			_manager: ConnectorAccountManager,
		) => {
			// Persistence of new accounts is owned by the manager's storage; this
			// adapter just normalizes the patch into a Discord-shaped account.
			return {
				...input,
				provider: DISCORD_PROVIDER_ID,
				role: input.role ?? "AGENT",
				purpose: input.purpose ?? ["messaging"],
				accessGate: input.accessGate ?? "open",
				status: input.status ?? "pending",
			};
		},
		patchAccount: async (
			_accountId: string,
			patch: ConnectorAccountPatch,
			_manager: ConnectorAccountManager,
		) => {
			return { ...patch, provider: DISCORD_PROVIDER_ID };
		},
		deleteAccount: async (
			accountId: string,
			_manager: ConnectorAccountManager,
		) => {
			// Persist the disabled policy before touching the gateway so a crash
			// or restart mid-disconnect cannot bring the account back. The token
			// itself lives in character settings or env, which the host owns; the
			// policy is keyed by its fingerprint, so that token stays unused until
			// it is replaced or the account is re-created. A failure below throws
			// before the manager removes its row, and a retry is idempotent.
			const account = resolveDiscordAccount(runtime, accountId);
			await persistDiscordAccountDisabled(runtime, account);
			const service = runtime.getService<DiscordService>(DISCORD_PROVIDER_ID);
			await service?.disconnectAccount(account.accountId);
		},
		startOAuth: async (
			request: ConnectorOAuthStartRequest,
			_manager: ConnectorAccountManager,
		): Promise<ConnectorOAuthStartResult> => {
			const applicationId = runtime.getSetting("DISCORD_APPLICATION_ID") as
				| string
				| undefined;
			if (!applicationId) {
				throw new Error(
					"DISCORD_APPLICATION_ID is not configured — cannot build install URL",
				);
			}
			const scopes = (request.scopes ?? ["bot", "applications.commands"]).join(
				"+",
			);
			// Default permissions bitflag: send messages, view channel, read message history (1024+2048+65536)
			const permissions = "68608";
			const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(
				applicationId,
			)}&scope=${scopes}&permissions=${permissions}`;
			return {
				authUrl,
				metadata: {
					mode: "bot_install",
					note: "Discord uses bot installation + /eliza-pair slash command instead of a code exchange.",
				},
			};
		},
		completeOAuth: async (
			request: ConnectorOAuthCallbackRequest,
			_manager: ConnectorAccountManager,
		): Promise<ConnectorOAuthCallbackResult> => {
			// Discord pairing is completed via the in-app slash command; the
			// callback simply marks the flow as completed and forwards any
			// account hints already attached to the flow.
			return {
				flow: { status: "completed" },
				account: {
					provider: DISCORD_PROVIDER_ID,
					status: "connected",
					accessGate: "pairing",
					metadata: {
						completedVia: "owner_pairing_slash_command",
						state: request.flow.state,
					},
				},
			};
		},
	};
}
