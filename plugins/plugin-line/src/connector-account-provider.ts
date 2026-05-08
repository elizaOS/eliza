/**
 * LINE ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.line`)
 * plus env-var fallbacks (LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET).
 * `listAccounts` enumerates all configured/enabled accounts; single-account
 * env-only deployments still surface as a `default` account.
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
  listEnabledLineAccounts,
  normalizeAccountId,
  type ResolvedLineAccount,
  resolveLineAccount,
} from "./accounts.js";

export const LINE_PROVIDER_ID = "line";

function purposeForAccount(_account: ResolvedLineAccount): string[] {
  return ["messaging"];
}

function accessGateForAccount(account: ResolvedLineAccount): string {
  const dmPolicy = account.config?.dmPolicy;
  if (dmPolicy === "pairing") return "pairing";
  if (dmPolicy === "disabled") return "disabled";
  return "open";
}

function roleForAccount(_account: ResolvedLineAccount): "OWNER" | "AGENT" {
  // LINE channel access tokens are bot tokens, not user-OAuth.
  return "AGENT";
}

function toConnectorAccount(account: ResolvedLineAccount): ConnectorAccount {
  const now = Date.now();
  return {
    id: normalizeAccountId(account.accountId),
    provider: LINE_PROVIDER_ID,
    label: account.name ?? account.accountId,
    role: roleForAccount(account),
    purpose: purposeForAccount(account),
    accessGate: accessGateForAccount(account),
    status: account.enabled && account.configured ? "connected" : "disabled",
    createdAt: now,
    updatedAt: now,
    metadata: {
      tokenSource: account.tokenSource,
      dmPolicy: account.config?.dmPolicy ?? "open",
      groupPolicy: account.config?.groupPolicy ?? "allowlist",
    },
  };
}

export function createLineConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: LINE_PROVIDER_ID,
    label: "LINE",
    listAccounts: async (_manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const enabled = listEnabledLineAccounts(runtime);
      if (enabled.length > 0) {
        return enabled.map(toConnectorAccount);
      }
      // Fall back to default account so single-account env-only deployments
      // still surface in the manager. Status reflects token configuration.
      const fallback = resolveLineAccount(runtime, DEFAULT_ACCOUNT_ID);
      return [toConnectorAccount(fallback)];
    },
    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: LINE_PROVIDER_ID,
        role: input.role ?? "AGENT",
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
      return { ...patch, provider: LINE_PROVIDER_ID };
    },
    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager) => {
      // No-op at provider layer — runtime credentials live in character
      // settings; deletion of those is out of band.
    },
  };
}
