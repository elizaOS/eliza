/**
 * Twitch ConnectorAccountManager provider.
 *
 * Adapts the multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.twitch`)
 * + TWITCH_ACCOUNTS JSON env var + single-account env vars (TWITCH_USERNAME,
 * TWITCH_CLIENT_ID, TWITCH_ACCESS_TOKEN, TWITCH_REFRESH_TOKEN, TWITCH_CHANNEL).
 *
 * AccountKey is the twitch user id (or username when only that's available).
 * Role is `OWNER` since twitch OAuth tokens authenticate the user/channel.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import {
  DEFAULT_TWITCH_ACCOUNT_ID,
  listTwitchAccountIds,
  normalizeTwitchAccountId,
  resolveTwitchAccountSettings,
} from "./accounts.js";
import type { TwitchSettings } from "./types.js";

export const TWITCH_PROVIDER_ID = "twitch";

function toConnectorAccount(settings: TwitchSettings): ConnectorAccount {
  const now = Date.now();
  const configured = Boolean(
    settings.username && settings.clientId && settings.accessToken,
  );
  return {
    id: normalizeTwitchAccountId(settings.accountId),
    provider: TWITCH_PROVIDER_ID,
    label: settings.username || settings.channel || settings.accountId,
    role: "OWNER",
    purpose: ["messaging"],
    accessGate: "open",
    status: settings.enabled !== false && configured ? "connected" : "disabled",
    externalId: settings.username || undefined,
    displayHandle: settings.username || undefined,
    createdAt: now,
    updatedAt: now,
    metadata: {
      channel: settings.channel ?? "",
      additionalChannels: settings.additionalChannels ?? [],
      requireMention: settings.requireMention ?? false,
      hasRefreshToken: Boolean(settings.refreshToken),
    },
  };
}

export function createTwitchConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: TWITCH_PROVIDER_ID,
    label: "Twitch",
    listAccounts: async (
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const ids = listTwitchAccountIds(runtime);
      if (ids.length === 0) {
        return [
          toConnectorAccount(
            resolveTwitchAccountSettings(runtime, DEFAULT_TWITCH_ACCOUNT_ID),
          ),
        ];
      }
      return ids.map((id) =>
        toConnectorAccount(resolveTwitchAccountSettings(runtime, id)),
      );
    },
    createAccount: async (
      input: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return {
        ...input,
        provider: TWITCH_PROVIDER_ID,
        role: input.role ?? "OWNER",
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
      return { ...patch, provider: TWITCH_PROVIDER_ID };
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
