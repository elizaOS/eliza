/**
 * Instagram ConnectorAccountManager provider.
 *
 * Instagram uses Graph API access tokens per business account. The `accountKey`
 * is the business_account_id. Multi-account deployments configure additional
 * accounts via `INSTAGRAM_ACCOUNTS` env JSON or
 * `character.settings.instagram.accounts`.
 *
 * The role here is `AGENT` (not OWNER) because Instagram tokens are scoped to
 * business accounts the agent operates on behalf of, not the user's personal
 * identity. Webhook demux is handled by the InstagramService via the per-target
 * accountId stamp.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import {
  listInstagramAccountIds,
  normalizeInstagramAccountId,
  resolveInstagramAccountConfig,
} from "./accounts";

export const INSTAGRAM_PROVIDER_ID = "instagram";

function toConnectorAccount(runtime: IAgentRuntime, accountId: string): ConnectorAccount {
  let connected = false;
  let username = "";
  try {
    const config = resolveInstagramAccountConfig(runtime, accountId);
    username = config.username ?? "";
    connected = Boolean(config.username && config.password);
  } catch {
    connected = false;
  }
  const now = Date.now();
  return {
    id: accountId,
    provider: INSTAGRAM_PROVIDER_ID,
    label: username || accountId,
    role: "AGENT",
    purpose: ["posting", "reading"],
    accessGate: "open",
    status: connected ? "connected" : "disabled",
    externalId: username || undefined,
    displayHandle: username || undefined,
    createdAt: now,
    updatedAt: now,
    metadata: {
      username,
    },
  };
}

export function createInstagramConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: INSTAGRAM_PROVIDER_ID,
    label: "Instagram",
    listAccounts: async (_manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const ids = listInstagramAccountIds(runtime);
      return ids.map((id) => toConnectorAccount(runtime, id));
    },
    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: INSTAGRAM_PROVIDER_ID,
        role: input.role ?? "AGENT",
        purpose: input.purpose ?? ["posting", "reading"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },
    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      return { ...patch, provider: INSTAGRAM_PROVIDER_ID };
    },
    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager) => {
      // Credentials live in character settings or env; out of band.
    },
  };
}

export { normalizeInstagramAccountId };
