/**
 * BlueBubbles ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.bluebubbles`)
 * plus env-var fallbacks (BLUEBUBBLES_SERVER_URL, BLUEBUBBLES_PASSWORD, ...).
 * Single-account env-only deployments still surface as a `default` account.
 *
 * BlueBubbles uses a server URL + password — there is no OAuth flow.
 */

import type {
	ConnectorAccount,
	ConnectorAccountManager,
	ConnectorAccountPatch,
	ConnectorAccountProvider,
	IAgentRuntime,
} from "@elizaos/core";
import {
	DEFAULT_ACCOUNT_ID,
	listEnabledBlueBubblesAccounts,
	normalizeAccountId,
	type ResolvedBlueBubblesAccount,
	resolveBlueBubblesAccount,
} from "./accounts.js";

export const BLUEBUBBLES_PROVIDER_ID = "bluebubbles";

function purposeForAccount(_account: ResolvedBlueBubblesAccount): string[] {
	return ["messaging"];
}

function accessGateForAccount(account: ResolvedBlueBubblesAccount): string {
	const dmPolicy = account.config?.dmPolicy;
	if (dmPolicy === "disabled") return "disabled";
	if (dmPolicy === "pairing") return "pairing";
	return "open";
}

function roleForAccount(_account: ResolvedBlueBubblesAccount): "OWNER" {
	// BlueBubbles fronts the user's own iMessage on a macOS host.
	return "OWNER";
}

function toConnectorAccount(
	account: ResolvedBlueBubblesAccount,
): ConnectorAccount {
	const now = Date.now();
	return {
		id: normalizeAccountId(account.accountId),
		provider: BLUEBUBBLES_PROVIDER_ID,
		label: account.name ?? account.accountId,
		role: roleForAccount(account),
		purpose: purposeForAccount(account),
		accessGate: accessGateForAccount(account),
		status: account.enabled && account.configured ? "connected" : "disabled",
		externalId: account.serverUrl || undefined,
		displayHandle: account.serverUrl || undefined,
		createdAt: now,
		updatedAt: now,
		metadata: {
			serverUrl: account.serverUrl,
			dmPolicy: account.config?.dmPolicy ?? "pairing",
			groupPolicy: account.config?.groupPolicy ?? "allowlist",
		},
	};
}

export function createBlueBubblesConnectorAccountProvider(
	runtime: IAgentRuntime,
): ConnectorAccountProvider {
	return {
		provider: BLUEBUBBLES_PROVIDER_ID,
		label: "BlueBubbles",
		listAccounts: async (
			_manager: ConnectorAccountManager,
		): Promise<ConnectorAccount[]> => {
			const enabled = listEnabledBlueBubblesAccounts(runtime);
			if (enabled.length > 0) {
				return enabled.map(toConnectorAccount);
			}
			const fallback = resolveBlueBubblesAccount(runtime, DEFAULT_ACCOUNT_ID);
			return [toConnectorAccount(fallback)];
		},
		createAccount: async (
			input: ConnectorAccountPatch,
			_manager: ConnectorAccountManager,
		) => {
			return {
				...input,
				provider: BLUEBUBBLES_PROVIDER_ID,
				role: input.role ?? "OWNER",
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
			return { ...patch, provider: BLUEBUBBLES_PROVIDER_ID };
		},
		deleteAccount: async (
			_accountId: string,
			_manager: ConnectorAccountManager,
		) => {
			// No-op: BlueBubbles credentials live in character settings / env.
		},
		// No OAuth — BlueBubbles uses server URL + password.
	};
}
