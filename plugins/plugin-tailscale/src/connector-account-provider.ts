/**
 * Tailscale ConnectorAccountManager provider.
 *
 * Adapts the existing multi-account resolver in `accounts.ts` to the
 * ConnectorAccountManager CRUD surface. Legacy single-account env/settings
 * are surfaced as the default OWNER account; additional accounts can be
 * declared through character.settings.tailscale.accounts or TAILSCALE_ACCOUNTS.
 *
 * Tailscale does not use an OAuth redirect flow here. Local CLI login and
 * cloud auth-key/API-key provisioning remain owned by the backend services.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  ConnectorAccountPurpose,
  IAgentRuntime,
} from '@elizaos/core';
import {
  type TailscaleAccountConfig,
  normalizeTailscaleAccountId,
  readTailscaleAccounts,
  resolveTailscaleAccountId,
} from './accounts';

export const TAILSCALE_PROVIDER_ID = 'tailscale';

const DEFAULT_PURPOSES: ConnectorAccountPurpose[] = [
  'admin' as ConnectorAccountPurpose,
  'automation' as ConnectorAccountPurpose,
];

function hasExplicitConfig(account: TailscaleAccountConfig): boolean {
  return Boolean(
    account.authKey ||
    account.tags !== undefined ||
    account.funnel !== undefined ||
    account.defaultPort !== undefined ||
    account.backend !== undefined ||
    account.authKeyExpirySeconds !== undefined ||
    account.cloudApiKey ||
    account.cloudBaseUrl,
  );
}

function authMethodForAccount(account: TailscaleAccountConfig): string {
  if (account.cloudApiKey) return 'cloud_api_key';
  if (account.authKey) return 'auth_key';
  if (account.backend === 'local') return 'local_cli';
  return 'runtime';
}

function toConnectorAccount(
  account: TailscaleAccountConfig,
  defaultAccountId: string,
): ConnectorAccount {
  const now = Date.now();
  const accountId = normalizeTailscaleAccountId(account.accountId);
  const configured = hasExplicitConfig(account);
  return {
    id: accountId,
    provider: TAILSCALE_PROVIDER_ID,
    label: account.label ?? `Tailscale (${accountId})`,
    role: 'OWNER',
    purpose: DEFAULT_PURPOSES,
    accessGate: 'open',
    status: configured ? 'connected' : 'disabled',
    displayHandle: account.label ?? accountId,
    createdAt: now,
    updatedAt: now,
    metadata: {
      authMethod: authMethodForAccount(account),
      source: 'legacy',
      isDefault: accountId === defaultAccountId,
      backend: account.backend ?? 'auto',
      funnel: account.funnel ?? null,
      defaultPort: account.defaultPort ?? null,
      tags: account.tags ?? null,
      authKeyExpirySeconds: account.authKeyExpirySeconds ?? null,
      hasAuthKey: Boolean(account.authKey),
      hasCloudApiKey: Boolean(account.cloudApiKey),
      cloudBaseUrl: account.cloudBaseUrl ?? null,
    },
  };
}

function normalizePurposes(
  purpose: ConnectorAccountPatch['purpose'] | undefined,
  fallback: ConnectorAccountPurpose[],
): ConnectorAccountPurpose[] {
  if (Array.isArray(purpose)) return purpose;
  if (typeof purpose === 'string' && purpose.trim()) return [purpose];
  return fallback;
}

function mergeStoredAccountPatch(
  account: ConnectorAccount,
  patch: ConnectorAccountPatch,
): ConnectorAccount {
  return {
    ...account,
    ...patch,
    provider: TAILSCALE_PROVIDER_ID,
    id: account.id,
    purpose: normalizePurposes(patch.purpose, account.purpose),
    externalId:
      patch.externalId === undefined ? account.externalId : (patch.externalId ?? undefined),
    displayHandle:
      patch.displayHandle === undefined
        ? account.displayHandle
        : (patch.displayHandle ?? undefined),
    ownerBindingId:
      patch.ownerBindingId === undefined
        ? account.ownerBindingId
        : (patch.ownerBindingId ?? undefined),
    ownerIdentityId:
      patch.ownerIdentityId === undefined
        ? account.ownerIdentityId
        : (patch.ownerIdentityId ?? undefined),
    metadata: patch.metadata ?? account.metadata,
    createdAt: account.createdAt,
  };
}

export function createTailscaleConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: TAILSCALE_PROVIDER_ID,
    label: 'Tailscale',

    listAccounts: async (manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const stored = await manager.getStorage().listAccounts(TAILSCALE_PROVIDER_ID);
      const storedById = new Set(stored.map((account) => account.id));
      const defaultAccountId = resolveTailscaleAccountId(runtime);
      const synthesized = readTailscaleAccounts(runtime)
        .map((account) => toConnectorAccount(account, defaultAccountId))
        .filter((account) => !storedById.has(account.id));
      return [...stored, ...synthesized];
    },

    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: TAILSCALE_PROVIDER_ID,
        role: input.role ?? 'OWNER',
        purpose: input.purpose ?? DEFAULT_PURPOSES,
        accessGate: input.accessGate ?? 'open',
        status: input.status ?? 'pending',
      };
    },

    patchAccount: async (
      accountId: string,
      patch: ConnectorAccountPatch,
      manager: ConnectorAccountManager,
    ) => {
      const existing = await manager.getStorage().getAccount(TAILSCALE_PROVIDER_ID, accountId);
      if (existing) {
        return mergeStoredAccountPatch(existing, patch);
      }
      return { ...patch, provider: TAILSCALE_PROVIDER_ID };
    },

    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager): Promise<void> => {
      // Runtime credentials live in env/character settings or the selected
      // backend; the manager removes only its account row.
    },
  };
}
