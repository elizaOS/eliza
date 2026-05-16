/**
 * Matrix ConnectorAccountManager provider.
 *
 * Adapts the multi-account scaffolding in `accounts.ts` to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth for accounts is character settings (`character.settings.matrix`)
 * + MATRIX_ACCOUNTS JSON env var + single-account env vars (MATRIX_HOMESERVER,
 * MATRIX_USER_ID, MATRIX_ACCESS_TOKEN). AccountKey is `<homeserver>/<userId>`
 * by convention; role is `OWNER` since matrix access tokens authenticate the
 * user, not a bot. E2EE keys are scoped per account by the matrix client and
 * are NOT shared between accounts.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import {
  DEFAULT_MATRIX_ACCOUNT_ID,
  listMatrixAccountIds,
  normalizeMatrixAccountId,
  resolveMatrixAccountSettings,
} from "./accounts.js";
import type { MatrixSettings } from "./types.js";

export const MATRIX_PROVIDER_ID = "matrix";

function accountKey(settings: MatrixSettings): string {
  // Convention: <homeserver>/<userId>; falls back to the configured accountId.
  if (settings.homeserver && settings.userId) {
    return `${settings.homeserver}/${settings.userId}`;
  }
  return normalizeMatrixAccountId(settings.accountId);
}

function toConnectorAccount(settings: MatrixSettings): ConnectorAccount {
  const now = Date.now();
  const configured = Boolean(settings.homeserver && settings.userId && settings.accessToken);
  return {
    id: normalizeMatrixAccountId(settings.accountId),
    provider: MATRIX_PROVIDER_ID,
    label: settings.userId || settings.accountId,
    role: "OWNER",
    purpose: ["messaging"],
    accessGate: "open",
    status: settings.enabled !== false && configured ? "connected" : "disabled",
    externalId: accountKey(settings),
    displayHandle: settings.userId || undefined,
    createdAt: now,
    updatedAt: now,
    metadata: {
      homeserver: settings.homeserver ?? "",
      userId: settings.userId ?? "",
      deviceId: settings.deviceId ?? "",
      encryption: settings.encryption ?? false,
      autoJoin: settings.autoJoin ?? false,
    },
  };
}

export function createMatrixConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: MATRIX_PROVIDER_ID,
    label: "Matrix",
    listAccounts: async (_manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const ids = listMatrixAccountIds(runtime);
      if (ids.length === 0) {
        return [
          toConnectorAccount(resolveMatrixAccountSettings(runtime, DEFAULT_MATRIX_ACCOUNT_ID)),
        ];
      }
      return ids.map((id) => toConnectorAccount(resolveMatrixAccountSettings(runtime, id)));
    },
    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: MATRIX_PROVIDER_ID,
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
      return { ...patch, provider: MATRIX_PROVIDER_ID };
    },
    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager) => {
      // No-op at provider layer — runtime credentials live in character
      // settings; deletion of those is out of band.
    },
  };
}
