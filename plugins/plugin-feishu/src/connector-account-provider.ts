/**
 * Feishu ConnectorAccountManager provider.
 *
 * Adapts the multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.feishu`)
 * plus env-var fallbacks (FEISHU_APP_ID, FEISHU_APP_SECRET). `listAccounts`
 * enumerates all configured/enabled accounts; single-account env-only
 * deployments still surface as a `default` account. AccountKey is the appId.
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
	listEnabledFeishuAccounts,
	normalizeAccountId,
	type ResolvedFeishuAccount,
	resolveFeishuAccount,
} from "./accounts.js";

export const FEISHU_PROVIDER_ID = "feishu";

function purposeForAccount(_account: ResolvedFeishuAccount): string[] {
	return ["messaging"];
}

function accessGateForAccount(account: ResolvedFeishuAccount): string {
	const dmPolicy = account.config?.dmPolicy;
	if (dmPolicy === "pairing") return "pairing";
	if (dmPolicy === "disabled") return "disabled";
	return "open";
}

function toConnectorAccount(account: ResolvedFeishuAccount): ConnectorAccount {
	const now = Date.now();
	return {
		id: normalizeAccountId(account.accountId),
		provider: FEISHU_PROVIDER_ID,
		label: account.name ?? account.accountId,
		role: "AGENT",
		purpose: purposeForAccount(account),
		accessGate: accessGateForAccount(account),
		status: account.enabled && account.configured ? "connected" : "disabled",
		externalId: account.appId || undefined,
		createdAt: now,
		updatedAt: now,
		metadata: {
			tokenSource: account.tokenSource,
			dmPolicy: account.config?.dmPolicy ?? "open",
			groupPolicy: account.config?.groupPolicy ?? "allowlist",
			appId: account.appId || "",
		},
	};
}

export function createFeishuConnectorAccountProvider(
	runtime: IAgentRuntime,
): ConnectorAccountProvider {
	return {
		provider: FEISHU_PROVIDER_ID,
		label: "Feishu",
		listAccounts: async (
			_manager: ConnectorAccountManager,
		): Promise<ConnectorAccount[]> => {
			const enabled = listEnabledFeishuAccounts(runtime);
			if (enabled.length > 0) {
				return enabled.map(toConnectorAccount);
			}
			const fallback = resolveFeishuAccount(runtime, DEFAULT_ACCOUNT_ID);
			return [toConnectorAccount(fallback)];
		},
		createAccount: async (
			input: ConnectorAccountPatch,
			_manager: ConnectorAccountManager,
		) => {
			return {
				...input,
				provider: FEISHU_PROVIDER_ID,
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
			return { ...patch, provider: FEISHU_PROVIDER_ID };
		},
		deleteAccount: async (
			_accountId: string,
			_manager: ConnectorAccountManager,
		) => {
			// No-op at provider layer — runtime credentials live in character
			// settings; deletion of those is out of band.
		},
	};
}
