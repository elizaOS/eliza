/**
 * WhatsApp ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.whatsapp`)
 * plus env-var fallbacks (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, ...).
 * Single-account env-only deployments still surface as a `default` account.
 *
 * WhatsApp Business Cloud API uses long-lived access tokens, not OAuth from
 * the bot's perspective. Pairing happens out of band when the user provisions
 * a phone_number_id in Meta Business Manager.
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
  const dmPolicy = account.config?.dmPolicy;
  if (dmPolicy === "disabled") return "disabled";
  if (dmPolicy === "pairing") return "pairing";
  return "open";
}

function roleForAccount(_account: ResolvedWhatsAppAccount): "OWNER" | "AGENT" {
  // WhatsApp Business API tokens act as the agent's own identity (the bot).
  return "AGENT";
}

function toConnectorAccount(account: ResolvedWhatsAppAccount): ConnectorAccount {
  const now = Date.now();
  return {
    id: normalizeAccountId(account.accountId),
    provider: WHATSAPP_PROVIDER_ID,
    label: account.name ?? account.accountId,
    role: roleForAccount(account),
    purpose: purposeForAccount(account),
    accessGate: accessGateForAccount(account),
    status: account.enabled && account.configured ? "connected" : "disabled",
    externalId: account.phoneNumberId || undefined,
    displayHandle: account.phoneNumberId || undefined,
    createdAt: now,
    updatedAt: now,
    metadata: {
      tokenSource: account.tokenSource,
      phoneNumberId: account.phoneNumberId,
      businessAccountId: account.businessAccountId ?? null,
      dmPolicy: account.config?.dmPolicy ?? "pairing",
      groupPolicy: account.config?.groupPolicy ?? "allowlist",
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
      const enabled = listEnabledWhatsAppAccounts(runtime);
      if (enabled.length > 0) {
        return enabled.map(toConnectorAccount);
      }
      const fallback = resolveWhatsAppAccount(runtime, DEFAULT_ACCOUNT_ID);
      return [toConnectorAccount(fallback)];
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
      // Persistent credentials live in character settings / env; deletion at
      // the manager layer is a no-op marker.
    },
    // WhatsApp Cloud API: provisioning is via Meta Business Manager. Baileys
    // uses QR pairing handled separately in `pairing-service.ts`. No OAuth.
  };
}
