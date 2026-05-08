/**
 * BlueSky ConnectorAccountManager provider.
 *
 * BlueSky uses AT Protocol with username + password (app password) per handle.
 * The `accountKey` is the BlueSky handle (e.g. `alice.bsky.social`). Multi-handle
 * deployments configure additional accounts via `BLUESKY_ACCOUNTS` env JSON or
 * `character.settings.bluesky.accounts`.
 *
 * Persistence of new accounts is owned by the manager's storage; the provider
 * adapter just normalizes the account shape.
 */

import type {
	ConnectorAccount,
	ConnectorAccountManager,
	ConnectorAccountPatch,
	ConnectorAccountProvider,
	IAgentRuntime,
} from "@elizaos/core";
import {
	listBlueSkyAccountIds,
	normalizeBlueSkyAccountId,
	resolveBlueSkyAccountConfig,
} from "./accounts";

export const BLUESKY_PROVIDER_ID = "bluesky";

function toConnectorAccount(
	runtime: IAgentRuntime,
	accountId: string,
): ConnectorAccount {
	const resolved = resolveBlueSkyAccountConfig(runtime, accountId);
	const now = Date.now();
	const connected = Boolean(resolved.handle && resolved.password);
	return {
		id: accountId,
		provider: BLUESKY_PROVIDER_ID,
		label: resolved.handle || accountId,
		role: "OWNER",
		purpose: ["posting", "reading"],
		accessGate: "open",
		status: connected ? "connected" : "disabled",
		externalId: resolved.handle || undefined,
		displayHandle: resolved.handle || undefined,
		createdAt: now,
		updatedAt: now,
		metadata: {
			service: resolved.service,
		},
	};
}

export function createBlueSkyConnectorAccountProvider(
	runtime: IAgentRuntime,
): ConnectorAccountProvider {
	return {
		provider: BLUESKY_PROVIDER_ID,
		label: "BlueSky",
		listAccounts: async (
			_manager: ConnectorAccountManager,
		): Promise<ConnectorAccount[]> => {
			const ids = listBlueSkyAccountIds(runtime);
			return ids.map((id) => toConnectorAccount(runtime, id));
		},
		createAccount: async (
			input: ConnectorAccountPatch,
			_manager: ConnectorAccountManager,
		) => {
			return {
				...input,
				provider: BLUESKY_PROVIDER_ID,
				role: input.role ?? "OWNER",
				purpose: input.purpose ?? ["posting", "reading"],
				accessGate: input.accessGate ?? "open",
				status: input.status ?? "pending",
			};
		},
		patchAccount: async (
			_accountId: string,
			patch: ConnectorAccountPatch,
			_manager: ConnectorAccountManager,
		) => {
			return { ...patch, provider: BLUESKY_PROVIDER_ID };
		},
		deleteAccount: async (
			_accountId: string,
			_manager: ConnectorAccountManager,
		) => {
			// Credential deletion lives in character settings or env; out of band.
		},
	};
}

export { normalizeBlueSkyAccountId };
