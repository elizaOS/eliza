/**
 * Nostr ConnectorAccountManager provider.
 *
 * Adapts the multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.nostr`)
 * + NOSTR_ACCOUNTS JSON env var + single-account env vars (NOSTR_PRIVATE_KEY,
 * NOSTR_RELAYS, NOSTR_DM_POLICY).
 *
 * AccountKey is the nostr pubkey (hex). Role is `OWNER` since the private key
 * is the user's identity. Public key is derived at service start time, so
 * `externalId` may be empty until the service has resolved it; the manager
 * tolerates this.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import {
  DEFAULT_NOSTR_ACCOUNT_ID,
  listNostrAccountIds,
  normalizeNostrAccountId,
  resolveNostrAccountSettings,
} from "./accounts.js";
import type { NostrSettings } from "./types.js";

export const NOSTR_PROVIDER_ID = "nostr";

function accessGateForAccount(settings: NostrSettings): string {
  if (settings.dmPolicy === "pairing") return "pairing";
  if (settings.dmPolicy === "disabled") return "disabled";
  return "open";
}

function toConnectorAccount(settings: NostrSettings): ConnectorAccount {
  const now = Date.now();
  const configured = Boolean(settings.privateKey);
  return {
    id: normalizeNostrAccountId(settings.accountId),
    provider: NOSTR_PROVIDER_ID,
    label: settings.profile?.name ?? settings.publicKey || settings.accountId,
    role: "OWNER",
    purpose: ["messaging"],
    accessGate: accessGateForAccount(settings),
    status: settings.enabled !== false && configured ? "connected" : "disabled",
    externalId: settings.publicKey || undefined,
    displayHandle: settings.profile?.name ?? settings.publicKey || undefined,
    createdAt: now,
    updatedAt: now,
    metadata: {
      relays: settings.relays ?? [],
      dmPolicy: settings.dmPolicy ?? "pairing",
      hasProfile: Boolean(settings.profile),
    },
  };
}

export function createNostrConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: NOSTR_PROVIDER_ID,
    label: "Nostr",
    listAccounts: async (
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const ids = listNostrAccountIds(runtime);
      if (ids.length === 0) {
        return [
          toConnectorAccount(
            resolveNostrAccountSettings(runtime, DEFAULT_NOSTR_ACCOUNT_ID),
          ),
        ];
      }
      return ids.map((id) =>
        toConnectorAccount(resolveNostrAccountSettings(runtime, id)),
      );
    },
    createAccount: async (
      input: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return {
        ...input,
        provider: NOSTR_PROVIDER_ID,
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
      return { ...patch, provider: NOSTR_PROVIDER_ID };
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
