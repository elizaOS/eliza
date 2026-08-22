/**
 * WhatsApp ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account resolution in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.whatsapp`)
 * plus the `WHATSAPP_AUTH_DIR` fallback.
 * Single-account env-only deployments still surface as a `default` account.
 *
 * Authentication is direct QR pairing through the in-process Baileys library.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  ConnectorAccountStatus,
  IAgentRuntime,
} from "@elizaos/core";
import {
  DEFAULT_ACCOUNT_ID,
  listEnabledWhatsAppAccounts,
  normalizeAccountId,
  type ResolvedWhatsAppAccount,
  resolveWhatsAppAccount,
} from "./accounts";

export const WHATSAPP_PROVIDER_ID = "whatsapp";

function purposeForAccount(_account: ResolvedWhatsAppAccount): string[] {
  return ["messaging"];
}

function accessGateForAccount(account: ResolvedWhatsAppAccount): string {
  const dmPolicy = account.config.dmPolicy;
  if (dmPolicy === "disabled") return "disabled";
  if (dmPolicy === "pairing") return "pairing";
  return "open";
}

function roleForAccount(_account: ResolvedWhatsAppAccount): "OWNER" | "AGENT" {
  // The paired WhatsApp session acts as the agent's own identity.
  return "AGENT";
}

type WhatsAppRuntimeStatusReader = {
  getAccountConnectionStatus(accountId?: string | null): "open" | "close" | "connecting" | null;
};

function accountStatus(
  account: ResolvedWhatsAppAccount,
  runtimeService: WhatsAppRuntimeStatusReader | null
): ConnectorAccountStatus {
  if (!account.enabled) return "disabled";
  if (!account.configured) return "pending";
  const liveStatus = runtimeService?.getAccountConnectionStatus(account.accountId) ?? null;
  if (liveStatus === "open") return "connected";
  if (liveStatus === "connecting" || liveStatus === null) return "pending";
  return "error";
}

function toConnectorAccount(
  account: ResolvedWhatsAppAccount,
  runtimeService: WhatsAppRuntimeStatusReader | null
): ConnectorAccount {
  const now = Date.now();
  return {
    id: normalizeAccountId(account.accountId),
    provider: WHATSAPP_PROVIDER_ID,
    label: account.name ?? account.accountId,
    role: roleForAccount(account),
    purpose: purposeForAccount(account),
    accessGate: accessGateForAccount(account),
    status: accountStatus(account, runtimeService),
    externalId: account.accountId,
    createdAt: now,
    updatedAt: now,
    metadata: {
      transport: "baileys",
      dmPolicy: account.config.dmPolicy ?? "pairing",
      groupPolicy: account.config.groupPolicy ?? "allowlist",
    },
  };
}

export function createWhatsAppConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: WHATSAPP_PROVIDER_ID,
    label: "WhatsApp",
    listAccounts: async (_manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const candidate = runtime.getService("whatsapp");
      const runtimeService =
        candidate &&
        typeof candidate === "object" &&
        "getAccountConnectionStatus" in candidate &&
        typeof candidate.getAccountConnectionStatus === "function"
          ? (candidate as WhatsAppRuntimeStatusReader)
          : null;
      const enabled = listEnabledWhatsAppAccounts(runtime);
      if (enabled.length > 0) {
        return enabled.map((account) => toConnectorAccount(account, runtimeService));
      }
      const fallback = resolveWhatsAppAccount(runtime, DEFAULT_ACCOUNT_ID);
      return [toConnectorAccount(fallback, runtimeService)];
    },
    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: WHATSAPP_PROVIDER_ID,
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
      return { ...patch, provider: WHATSAPP_PROVIDER_ID };
    },
    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager) => {
      // Session deletion is owned by the authenticated disconnect route.
    },
    // QR pairing is handled by `pairing-service.ts`; there is no external OAuth app.
  };
}
