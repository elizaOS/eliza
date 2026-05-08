/**
 * useConnectorAccounts — UI-facing connector account inventory hook.
 *
 * The backend route family is `/api/connectors/:provider/accounts`.
 * `connectorId` remains a UI grouping key for legacy connector config cards.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../api";
import type {
  ConnectorAccountActionResult,
  ConnectorAccountCreateInput,
  ConnectorAccountRecord,
  ConnectorAccountsListResponse,
  ConnectorAccountUpdateInput,
} from "../api/client-agent";

export const DEFAULT_CONNECTOR_ACCOUNT_ID = "default";

type ActionTone = "info" | "success" | "error";

type ActionNoticeFn = (
  text: string,
  tone?: ActionTone,
  ttlMs?: number,
  once?: boolean,
  busy?: boolean,
) => void;

export interface UseConnectorAccountsOptions {
  setActionNotice?: ActionNoticeFn;
  pollMs?: number;
  enabled?: boolean;
  initialSelectedAccountId?: string | null;
}

export interface UseConnectorAccountsResult {
  data: ConnectorAccountsListResponse | null;
  accounts: ConnectorAccountRecord[];
  loading: boolean;
  error: string | null;
  saving: Set<string>;
  defaultAccountId: string | null;
  selectedAccountId: string | null;
  selectedAccount: ConnectorAccountRecord | null;
  effectiveAccountId: string | null;
  setSelectedAccountId: (accountId: string | null) => void;
  refresh: () => Promise<void>;
  add: (
    body?: ConnectorAccountCreateInput,
  ) => Promise<ConnectorAccountActionResult>;
  update: (
    accountId: string,
    body: ConnectorAccountUpdateInput,
  ) => Promise<ConnectorAccountRecord>;
  test: (accountId: string) => Promise<ConnectorAccountActionResult>;
  refreshAccount: (accountId: string) => Promise<ConnectorAccountActionResult>;
  remove: (accountId: string) => Promise<ConnectorAccountActionResult>;
  makeDefault: (accountId: string) => Promise<ConnectorAccountActionResult>;
}

const DEFAULT_POLL_MS = 30_000;

function describeError(prefix: string, err: unknown): string {
  return err instanceof Error && err.message.trim()
    ? `${prefix}: ${err.message}`
    : prefix;
}

function getPreferredAccountId(
  data: ConnectorAccountsListResponse | null,
): string | null {
  if (!data || data.accounts.length === 0) return null;
  if (
    data.defaultAccountId &&
    data.accounts.some((account) => account.id === data.defaultAccountId)
  ) {
    return data.defaultAccountId;
  }
  return (
    data.accounts.find(
      (account) => account.isDefault && account.status === "connected",
    )?.id ??
    data.accounts.find((account) => account.status === "connected")?.id ??
    null
  );
}

function replaceAccount(
  data: ConnectorAccountsListResponse | null,
  account: ConnectorAccountRecord,
): ConnectorAccountsListResponse | null {
  if (!data) return data;
  const exists = data.accounts.some((item) => item.id === account.id);
  return {
    ...data,
    accounts: exists
      ? data.accounts.map((item) => (item.id === account.id ? account : item))
      : [...data.accounts, account],
  };
}

export function useConnectorAccounts(
  provider: string,
  connectorId = provider,
  options: UseConnectorAccountsOptions = {},
): UseConnectorAccountsResult {
  const {
    enabled = true,
    initialSelectedAccountId = null,
    pollMs = DEFAULT_POLL_MS,
    setActionNotice,
  } = options;
  const [data, setData] = useState<ConnectorAccountsListResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Set<string>>(() => new Set());
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    initialSelectedAccountId,
  );
  const mountedRef = useRef(true);

  const canFetch =
    enabled && provider.trim().length > 0 && connectorId.trim().length > 0;

  const notify = useCallback(
    (prefix: string, err: unknown) => {
      const message = describeError(prefix, err);
      setActionNotice?.(message, "error", 6000);
      return message;
    },
    [setActionNotice],
  );

  const markSaving = useCallback((key: string, on: boolean) => {
    setSaving((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!canFetch) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await client.listConnectorAccounts(provider, connectorId);
      if (!mountedRef.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(notify("Failed to load connector accounts", err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [canFetch, connectorId, notify, provider]);

  const add = useCallback<UseConnectorAccountsResult["add"]>(
    async (body = {}) => {
      const key = `add:${provider}:${connectorId}`;
      markSaving(key, true);
      try {
        const result = await client.addConnectorAccount(
          provider,
          connectorId,
          body,
        );
        const account = result.account;
        if (account) {
          setData((prev) => replaceAccount(prev, account));
          setSelectedAccountId(account.id);
        } else {
          await refresh();
        }
        return result;
      } catch (err) {
        notify("Failed to add connector account", err);
        throw err;
      } finally {
        markSaving(key, false);
      }
    },
    [connectorId, markSaving, notify, provider, refresh],
  );

  const update = useCallback<UseConnectorAccountsResult["update"]>(
    async (accountId, body) => {
      markSaving(accountId, true);
      try {
        const updated = await client.patchConnectorAccount(
          provider,
          connectorId,
          accountId,
          body,
        );
        setData((prev) => replaceAccount(prev, updated));
        return updated;
      } catch (err) {
        notify("Failed to update connector account", err);
        throw err;
      } finally {
        markSaving(accountId, false);
      }
    },
    [connectorId, markSaving, notify, provider],
  );

  const test = useCallback<UseConnectorAccountsResult["test"]>(
    async (accountId) => {
      const key = `test:${accountId}`;
      markSaving(key, true);
      try {
        return await client.testConnectorAccount(
          provider,
          connectorId,
          accountId,
        );
      } catch (err) {
        notify("Failed to test connector account", err);
        throw err;
      } finally {
        markSaving(key, false);
      }
    },
    [connectorId, markSaving, notify, provider],
  );

  const refreshAccount = useCallback<
    UseConnectorAccountsResult["refreshAccount"]
  >(
    async (accountId) => {
      const key = `refresh:${accountId}`;
      markSaving(key, true);
      try {
        const result = await client.refreshConnectorAccount(
          provider,
          connectorId,
          accountId,
        );
        const account = result.account;
        setData((prev) => (account ? replaceAccount(prev, account) : prev));
        if (!account) await refresh();
        return result;
      } catch (err) {
        notify("Failed to refresh connector account", err);
        throw err;
      } finally {
        markSaving(key, false);
      }
    },
    [connectorId, markSaving, notify, provider, refresh],
  );

  const remove = useCallback<UseConnectorAccountsResult["remove"]>(
    async (accountId) => {
      markSaving(accountId, true);
      try {
        const result = await client.deleteConnectorAccount(
          provider,
          connectorId,
          accountId,
        );
        setData((prev) =>
          prev
            ? {
                ...prev,
                accounts: prev.accounts.filter(
                  (account) => account.id !== accountId,
                ),
                defaultAccountId:
                  prev.defaultAccountId === accountId
                    ? null
                    : prev.defaultAccountId,
              }
            : prev,
        );
        setSelectedAccountId((prev) => (prev === accountId ? null : prev));
        return result;
      } catch (err) {
        notify("Failed to delete connector account", err);
        throw err;
      } finally {
        markSaving(accountId, false);
      }
    },
    [connectorId, markSaving, notify, provider],
  );

  const makeDefault = useCallback<UseConnectorAccountsResult["makeDefault"]>(
    async (accountId) => {
      const key = `default:${accountId}`;
      markSaving(key, true);
      try {
        const result = await client.makeDefaultConnectorAccount(
          provider,
          connectorId,
          accountId,
        );
        setData((prev) =>
          prev
            ? {
                ...prev,
                defaultAccountId: result.defaultAccountId ?? accountId,
                accounts: prev.accounts.map((account) => ({
                  ...account,
                  isDefault: account.id === accountId,
                })),
              }
            : prev,
        );
        setSelectedAccountId(accountId);
        return result;
      } catch (err) {
        notify("Failed to make connector account default", err);
        throw err;
      } finally {
        markSaving(key, false);
      }
    },
    [connectorId, markSaving, notify, provider],
  );

  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const defaultAccountId = getPreferredAccountId(data);
  const effectiveAccountId = selectedAccountId ?? defaultAccountId;
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === effectiveAccountId) ?? null,
    [accounts, effectiveAccountId],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (pollMs <= 0 || !canFetch) return;
    const id = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [canFetch, pollMs, refresh]);

  useEffect(() => {
    if (accounts.length === 0) return;
    setSelectedAccountId((prev) => {
      if (prev && accounts.some((account) => account.id === prev)) return prev;
      return defaultAccountId;
    });
  }, [accounts, defaultAccountId]);

  return {
    data,
    accounts,
    loading,
    error,
    saving,
    defaultAccountId,
    selectedAccountId,
    selectedAccount,
    effectiveAccountId,
    setSelectedAccountId,
    refresh,
    add,
    update,
    test,
    refreshAccount,
    remove,
    makeDefault,
  };
}
