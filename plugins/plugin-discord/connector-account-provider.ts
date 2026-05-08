/**
 * Discord ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.discord`)
 * plus the legacy env-only DISCORD_API_TOKEN. The manager observes those via
 * `listAccounts`. `createAccount`/`patchAccount`/`deleteAccount` here are
 * adapters that surface a `ConnectorAccount` shape; persistent storage is
 * delegated to the manager's `ConnectorAccountStorage`.
 *
 * OAuth: Discord uses bot installation (out-of-band) plus an in-app pairing
 * flow handled by `owner-pairing-service.ts`. `startOAuth` returns a Discord
 * application install URL; `completeOAuth` is a no-op marker because the
 * pairing happens via the `/eliza-pair` slash command, not a redirect.
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
	DEFAULT_ACCOUNT_ID,
	listEnabledDiscordAccounts,
	normalizeAccountId,
	type ResolvedDiscordAccount,
	resolveDiscordAccount,
} from "./accounts";

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

function toConnectorAccount(account: ResolvedDiscordAccount): ConnectorAccount {
	const now = Date.now();
	return {
		id: normalizeAccountId(account.accountId),
		provider: DISCORD_PROVIDER_ID,
		label: account.name ?? account.accountId,
		role: roleForAccount(account),
		purpose: purposeForAccount(account),
		accessGate: accessGateForAccount(account),
		status: account.enabled && account.token ? "connected" : "disabled",
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
		listAccounts: async (
			_manager: ConnectorAccountManager,
		): Promise<ConnectorAccount[]> => {
			const enabled = listEnabledDiscordAccounts(runtime);
			if (enabled.length > 0) {
				return enabled.map(toConnectorAccount);
			}
			// Fall back to the default account so single-account env-only
			// deployments still surface in the manager. Status reflects whether
			// a token is actually configured.
			const fallback = resolveDiscordAccount(runtime, DEFAULT_ACCOUNT_ID);
			return [toConnectorAccount(fallback)];
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
			_accountId: string,
			_manager: ConnectorAccountManager,
		) => {
			// No-op at the provider layer — runtime credentials live in character
			// settings; deletion of those is out of band.
		},
		startOAuth: async (
			request: ConnectorOAuthStartRequest,
			_manager: ConnectorAccountManager,
		): Promise<ConnectorOAuthStartResult> => {
			const applicationId = runtime.getSetting(
				"DISCORD_APPLICATION_ID",
			) as string | undefined;
			if (!applicationId) {
				throw new Error(
					"DISCORD_APPLICATION_ID is not configured — cannot build install URL",
				);
			}
			const scopes = (request.scopes ?? ["bot", "applications.commands"])
				.join("+");
			// Default permissions bitflag: SEND_MESSAGES|VIEW_CHANNEL|READ_MESSAGE_HISTORY (1024+2048+65536)
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
