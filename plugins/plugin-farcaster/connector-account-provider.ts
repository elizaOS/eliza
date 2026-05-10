/**
 * Farcaster ConnectorAccountManager provider.
 *
 * Farcaster auth: Neynar API key + signer UUID per FID. The `accountKey` is the
 * Farcaster ID (FID). Multi-FID deployments configure additional accounts via
 * `FARCASTER_ACCOUNTS` env JSON or `character.settings.farcaster.accounts`.
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
	listFarcasterAccountIds,
	normalizeFarcasterAccountId,
	validateFarcasterConfig,
} from "./utils/config";

export const FARCASTER_PROVIDER_ID = "farcaster";

function toConnectorAccount(
	runtime: IAgentRuntime,
	accountId: string,
): ConnectorAccount {
	let connected = false;
	let fid: number | undefined;
	let hubUrl = "";
	try {
		const config = validateFarcasterConfig(runtime, accountId);
		fid = config.FARCASTER_FID;
		hubUrl = config.FARCASTER_HUB_URL ?? "";
		connected = Boolean(
			fid && config.FARCASTER_SIGNER_UUID && config.FARCASTER_NEYNAR_API_KEY,
		);
	} catch {
		connected = false;
	}
	const now = Date.now();
	return {
		id: accountId,
		provider: FARCASTER_PROVIDER_ID,
		label: fid ? `FID ${fid}` : accountId,
		role: "OWNER",
		purpose: ["posting", "reading"],
		accessGate: "open",
		status: connected ? "connected" : "disabled",
		externalId: fid ? String(fid) : undefined,
		displayHandle: fid ? String(fid) : undefined,
		createdAt: now,
		updatedAt: now,
		metadata: {
			hubUrl,
			fid,
		},
	};
}

export function createFarcasterConnectorAccountProvider(
	runtime: IAgentRuntime,
): ConnectorAccountProvider {
	return {
		provider: FARCASTER_PROVIDER_ID,
		label: "Farcaster",
		listAccounts: async (
			_manager: ConnectorAccountManager,
		): Promise<ConnectorAccount[]> => {
			const ids = listFarcasterAccountIds(runtime);
			return ids.map((id) => toConnectorAccount(runtime, id));
		},
		createAccount: async (
			input: ConnectorAccountPatch,
			_manager: ConnectorAccountManager,
		) => {
			return {
				...input,
				provider: FARCASTER_PROVIDER_ID,
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
			return { ...patch, provider: FARCASTER_PROVIDER_ID };
		},
		deleteAccount: async (
			_accountId: string,
			_manager: ConnectorAccountManager,
		) => {
			// Credentials live in character settings or env; out of band.
		},
	};
}

export { normalizeFarcasterAccountId };
