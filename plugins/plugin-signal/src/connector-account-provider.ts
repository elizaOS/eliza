/**
 * Signal ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.signal`)
 * plus env-var fallbacks (SIGNAL_ACCOUNT_NUMBER, SIGNAL_HTTP_URL, SIGNAL_CLI_PATH).
 * Single-account env-only deployments still surface as a `default` account.
 *
 * Signal pairing happens out of band via signal-cli device link / QR code (see
 * `pairing-service.ts` + `setup-routes.ts`); there is no OAuth flow.
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
  listEnabledSignalAccounts,
  normalizeAccountId,
  type ResolvedSignalAccount,
  resolveSignalAccount,
} from "./accounts";

export const SIGNAL_PROVIDER_ID = "signal";

function purposeForAccount(_account: ResolvedSignalAccount): string[] {
  return ["messaging"];
}

function accessGateForAccount(account: ResolvedSignalAccount): string {
  // Signal numbers are owner-paired via signal-cli device link.
  const dmPolicy = account.config?.dm?.policy;
  if (dmPolicy === "disabled") return "disabled";
  if (dmPolicy === "pairing") return "pairing";
  // Default: device link is itself a pairing operation, so treat as pairing.
  return "pairing";
}

function roleForAccount(_account: ResolvedSignalAccount): "OWNER" | "AGENT" {
  // Signal accounts are linked to a real phone number owned by the user.
  return "OWNER";
}

function toConnectorAccount(account: ResolvedSignalAccount): ConnectorAccount {
  const now = Date.now();
  return {
    id: normalizeAccountId(account.accountId),
    provider: SIGNAL_PROVIDER_ID,
    label: account.name ?? account.account ?? account.accountId,
    role: roleForAccount(account),
    purpose: purposeForAccount(account),
    accessGate: accessGateForAccount(account),
    status: account.enabled && account.configured ? "connected" : "disabled",
    externalId: account.account,
    displayHandle: account.account,
    createdAt: now,
    updatedAt: now,
    metadata: {
      phoneNumber: account.account,
      baseUrl: account.baseUrl,
      dmPolicy: account.config?.dm?.policy ?? "pairing",
      groupPolicy: account.config?.group?.policy ?? "open",
    },
  };
}

export function createSignalConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: SIGNAL_PROVIDER_ID,
    label: "Signal",
    listAccounts: async (_manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const enabled = listEnabledSignalAccounts(runtime);
      if (enabled.length > 0) {
        return enabled.map(toConnectorAccount);
      }
      const fallback = resolveSignalAccount(runtime, DEFAULT_ACCOUNT_ID);
      return [toConnectorAccount(fallback)];
    },
    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: SIGNAL_PROVIDER_ID,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["messaging"],
        accessGate: input.accessGate ?? "pairing",
        status: input.status ?? "pending",
      };
    },
    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      return { ...patch, provider: SIGNAL_PROVIDER_ID };
    },
    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager) => {
      // Persistent credentials for Signal live in signal-cli auth dir;
      // unlinking happens via `signalLogout`. Deletion at the manager layer is
      // a no-op marker.
    },
    // Signal uses device-link pairing (QR code via signal-cli), not OAuth.
    // startOAuth/completeOAuth intentionally omitted.
  };
}
