/**
 * iMessage ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.imessage`)
 * plus env-var fallbacks (IMESSAGE_CLI_PATH, IMESSAGE_DB_PATH, ...).
 * In practice there is a single local macOS Messages account per host, but the
 * accountId surface still applies for multi-handle deployments.
 *
 * iMessage does not use OAuth — it reads the local chat.db on macOS.
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
  listEnabledIMessageAccounts,
  normalizeAccountId,
  type ResolvedIMessageAccount,
  resolveIMessageAccount,
} from "./accounts.js";

export const IMESSAGE_PROVIDER_ID = "imessage";

function purposeForAccount(_account: ResolvedIMessageAccount): string[] {
  return ["messaging"];
}

function accessGateForAccount(account: ResolvedIMessageAccount): string {
  const dmPolicy = account.config?.dmPolicy;
  if (dmPolicy === "disabled") return "disabled";
  if (dmPolicy === "pairing") return "pairing";
  return "open";
}

function roleForAccount(_account: ResolvedIMessageAccount): "OWNER" | "AGENT" {
  // iMessage uses the macOS user's own Messages app; always OWNER.
  return "OWNER";
}

function toConnectorAccount(account: ResolvedIMessageAccount): ConnectorAccount {
  const now = Date.now();
  return {
    id: normalizeAccountId(account.accountId),
    provider: IMESSAGE_PROVIDER_ID,
    label: account.name ?? account.accountId,
    role: roleForAccount(account),
    purpose: purposeForAccount(account),
    accessGate: accessGateForAccount(account),
    status: account.enabled ? "connected" : "disabled",
    createdAt: now,
    updatedAt: now,
    metadata: {
      cliPath: account.cliPath,
      dbPath: account.dbPath ?? null,
      dmPolicy: account.config?.dmPolicy ?? "pairing",
      groupPolicy: account.config?.groupPolicy ?? "allowlist",
    },
  };
}

export function createIMessageConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: IMESSAGE_PROVIDER_ID,
    label: "iMessage",
    listAccounts: async (_manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const enabled = listEnabledIMessageAccounts(runtime);
      if (enabled.length > 0) {
        return enabled.map(toConnectorAccount);
      }
      const fallback = resolveIMessageAccount(runtime, DEFAULT_ACCOUNT_ID);
      return [toConnectorAccount(fallback)];
    },
    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: IMESSAGE_PROVIDER_ID,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["messaging"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },
    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      return { ...patch, provider: IMESSAGE_PROVIDER_ID };
    },
    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager) => {
      // No-op: iMessage account state is the macOS Messages app; out-of-band.
    },
    // No OAuth — iMessage reads the local chat.db on macOS.
  };
}
