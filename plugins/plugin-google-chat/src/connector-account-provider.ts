/**
 * Google Chat ConnectorAccountManager provider.
 *
 * Adapts the multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.googleChat`)
 * + GOOGLE_CHAT_ACCOUNTS JSON env var + single-account env vars
 * (GOOGLE_CHAT_SERVICE_ACCOUNT, GOOGLE_CHAT_SERVICE_ACCOUNT_FILE).
 *
 * AccountKey is the service-account email (best-effort extracted from the
 * service-account JSON when available, otherwise the configured accountId).
 * Role is `AGENT` since service-account creds authenticate the bot, not a user.
 *
 * Note: this overlaps with plugin-google's OAuth scopes but is a separate
 * plugin scoped to Google Workspace Chat — keep separate.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import {
  DEFAULT_GOOGLE_CHAT_ACCOUNT_ID,
  listGoogleChatAccountIds,
  normalizeGoogleChatAccountId,
  resolveGoogleChatAccountSettings,
} from "./accounts.js";
import type { GoogleChatSettings } from "./types.js";

export const GOOGLE_CHAT_PROVIDER_ID = "google-chat";

function extractServiceAccountEmail(serviceAccount?: string): string | undefined {
  if (!serviceAccount) return undefined;
  try {
    const parsed = JSON.parse(serviceAccount) as { client_email?: string };
    return typeof parsed.client_email === "string" ? parsed.client_email : undefined;
  } catch {
    return undefined;
  }
}

function toConnectorAccount(settings: GoogleChatSettings): ConnectorAccount {
  const now = Date.now();
  const configured = Boolean(settings.serviceAccount || settings.serviceAccountFile);
  const email = extractServiceAccountEmail(settings.serviceAccount);
  return {
    id: normalizeGoogleChatAccountId(settings.accountId),
    provider: GOOGLE_CHAT_PROVIDER_ID,
    label: email ?? settings.botUser ?? settings.accountId ?? DEFAULT_GOOGLE_CHAT_ACCOUNT_ID,
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: settings.enabled !== false && configured ? "connected" : "disabled",
    externalId: email ?? undefined,
    displayHandle: email ?? settings.botUser ?? undefined,
    createdAt: now,
    updatedAt: now,
    metadata: {
      audienceType: settings.audienceType,
      audience: settings.audience ?? "",
      webhookPath: settings.webhookPath,
      requireMention: settings.requireMention,
      botUser: settings.botUser ?? "",
    },
  };
}

export function createGoogleChatConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: GOOGLE_CHAT_PROVIDER_ID,
    label: "Google Chat",
    listAccounts: async (
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const ids = listGoogleChatAccountIds(runtime);
      if (ids.length === 0) {
        return [
          toConnectorAccount(
            resolveGoogleChatAccountSettings(runtime, DEFAULT_GOOGLE_CHAT_ACCOUNT_ID),
          ),
        ];
      }
      return ids.map((id) =>
        toConnectorAccount(resolveGoogleChatAccountSettings(runtime, id)),
      );
    },
    createAccount: async (
      input: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return {
        ...input,
        provider: GOOGLE_CHAT_PROVIDER_ID,
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
      return { ...patch, provider: GOOGLE_CHAT_PROVIDER_ID };
    },
    deleteAccount: async (
      _accountId: string,
      _manager: ConnectorAccountManager,
    ) => {
      // No-op at provider layer — service-account credentials live in
      // character settings; deletion of those is out of band.
    },
  };
}
