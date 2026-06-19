/**
 * useAccounts — fetches and mutates the multi-account credential pool
 * surfaced by `/api/accounts/*`.
 *
 * Polls `client.listAccounts()` on a configurable interval (default 30s)
 * to keep usage / health rows fresh. Each mutation routes through the
 * matching client method, applies an optimistic local update where safe,
 * and reconciles after the server response. Failures bubble through
 * `setActionNotice` so the parent settings panel can surface them.
 */

import type {
  LinkedAccountConfig,
  LinkedAccountProviderId,
} from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import type {
  AccountRefreshUsageResult,
  AccountStrategy,
  AccountsListResponse,
  AccountTestResult,
} from "../api/client-agent";

type ActionTone = "info" | "success" | "error";

type ActionNoticeFn = (
  text: string,
  tone?: ActionTone,
  ttlMs?: number,
  once?: boolean,
  busy?: boolean,
) => void;

export interface UseAccountsOptions {
  setActionNotice?: ActionNoticeFn;
  /** How often to refetch the full list. Defaults to 30s. */
  pollMs?: number;
}

export interface UseAccountsResult {
  data: AccountsListResponse | null;
  loading: boolean;
  saving: Set<string>;
  refresh: () => Promise<void>;
  createApiKey: (
    providerId: LinkedAccountProviderId,
    body: { label: string; apiKey: string },
  ) => Promise<void>;
  patch: (
    providerId: LinkedAccountProviderId,
    accountId: string,
    body: Partial<{ label: string; enabled: boolean; priority: number }>,
  ) => Promise<void>;
  remove: (
    providerId: LinkedAccountProviderId,
    accountId: string,
  ) => Promise<void>;
  test: (
    providerId: LinkedAccountProviderId,
    accountId: string,
  ) => Promise<AccountTestResult>;
  refreshUsage: (
    providerId: LinkedAccountProviderId,
    accountId: string,
  ) => Promise<void>;
  setStrategy: (
    providerId: LinkedAccountProviderId,
    strategy: AccountStrategy,
  ) => Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;

function describeError(prefix: string, err: unknown): string {
  const message =
    err instanceof Error && err.message.trim()
      ? `${prefix}: ${err.message}`
      : prefix;
  return message;
}

function replaceAccount(
  list: AccountsListResponse | null,
  providerId: LinkedAccountProviderId,
  next: LinkedAccountConfig,
): AccountsListResponse | null {
  if (!list) return list;
  return {
    providers: list.providers.map((p) => {
      if (p.providerId !== providerId) return p;
      const existing = p.accounts.find((a) => a.id === next.id);
      const merged = existing
        ? { ...existing, ...next }
        : { ...next, hasCredential: true };
      return {
        ...p,
        accounts: p.accounts
          .map((a) => (a.id === next.id ? merged : a))
          .sort((a, b) => a.priority - b.priority),
      };
    }),
  };
}

export function useAccounts(opts: UseAccountsOptions = {}): UseAccountsResult {
  const { setActionNotice, pollMs = DEFAULT_POLL_MS } = opts;
  const [data, setData] = useState<AccountsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Set<string>>(() => new Set<string>());
  const mountedRef = useRef(true);

  const notify = useCallback(
    (prefix: string, err: unknown) => {
      setActionNotice?.(describeError(prefix, err), "error", 6000);
    },
    [setActionNotice],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await client.listAccounts();
      if (!mountedRef.current) return;
      setData(next);
    } catch (err) {
      if (!mountedRef.current) return;
      notify("Failed to load accounts", err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [notify]);

  const markSaving = useCallback((id: string, on: boolean) => {
    setSaving((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const createApiKey = useCallback<UseAccountsResult["createApiKey"]>(
    async (providerId, body) => {
      const key = `create:${providerId}`;
      markSaving(key, true);
      try {
        const created = await client.createApiKeyAccount(providerId, body);
        setData((prev) => {
          if (!prev) return prev;
          return {
            providers: prev.providers.map((p) => {
              if (p.providerId !== providerId) return p;
              const accounts = [
                ...p.accounts,
                { ...created, hasCredential: true },
              ].sort((a, b) => a.priority - b.priority);
              return { ...p, accounts };
            }),
          };
        });
        await refresh();
      } catch (err) {
        notify("Failed to create account", err);
        throw err;
      } finally {
        markSaving(key, false);
      }
    },
    [markSaving, notify, refresh],
  );

  const patch = useCallback<UseAccountsResult["patch"]>(
    async (providerId, accountId, body) => {
      markSaving(accountId, true);
      const previous = data;
      // Optimistic update for safe fields.
      setData((prev) => {
        if (!prev) return prev;
        return {
          providers: prev.providers.map((p) => {
            if (p.providerId !== providerId) return p;
            return {
              ...p,
              accounts: p.accounts
                .map((a) => (a.id === accountId ? { ...a, ...body } : a))
                .sort((x, y) => x.priority - y.priority),
            };
          }),
        };
      });
      try {
        const updated = await client.patchAccount(providerId, accountId, body);
        setData((prev) => replaceAccount(prev, providerId, updated));
      } catch (err) {
        setData(previous);
        notify("Failed to update account", err);
        throw err;
      } finally {
        markSaving(accountId, false);
      }
    },
    [data, markSaving, notify],
  );

  const remove = useCallback<UseAccountsResult["remove"]>(
    async (providerId, accountId) => {
      markSaving(accountId, true);
      try {
        await client.deleteAccount(providerId, accountId);
        setData((prev) => {
          if (!prev) return prev;
          return {
            providers: prev.providers.map((p) =>
              p.providerId === providerId
                ? {
                    ...p,
                    accounts: p.accounts.filter((a) => a.id !== accountId),
                  }
                : p,
            ),
          };
        });
      } catch (err) {
        notify("Failed to delete account", err);
        throw err;
      } finally {
        markSaving(accountId, false);
      }
    },
    [markSaving, notify],
  );

  const test = useCallback<UseAccountsResult["test"]>(
    async (providerId, accountId) => {
      markSaving(`test:${accountId}`, true);
      try {
        const result = await client.testAccount(providerId, accountId);
        if (result.ok) {
          setActionNotice?.(
            `Connection OK${
              typeof result.latencyMs === "number"
                ? ` (${result.latencyMs}ms)`
                : ""
            }`,
            "success",
            3000,
          );
        } else {
          setActionNotice?.(
            `Connection failed: ${result.error ?? `HTTP ${result.status ?? "?"}`}`,
            "error",
            6000,
          );
        }
        return result;
      } catch (err) {
        notify("Failed to test account", err);
        throw err;
      } finally {
        markSaving(`test:${accountId}`, false);
      }
    },
    [markSaving, notify, setActionNotice],
  );

  const refreshUsage = useCallback<UseAccountsResult["refreshUsage"]>(
    async (providerId, accountId) => {
      markSaving(`usage:${accountId}`, true);
      try {
        const result: AccountRefreshUsageResult =
          await client.refreshAccountUsage(providerId, accountId);
        setData((prev) => replaceAccount(prev, providerId, result.account));
      } catch (err) {
        notify("Failed to refresh usage", err);
        throw err;
      } finally {
        markSaving(`usage:${accountId}`, false);
      }
    },
    [markSaving, notify],
  );

  const setStrategy = useCallback<UseAccountsResult["setStrategy"]>(
    async (providerId, strategy) => {
      const key = `strategy:${providerId}`;
      markSaving(key, true);
      const previous = data;
      setData((prev) => {
        if (!prev) return prev;
        return {
          providers: prev.providers.map((p) =>
            p.providerId === providerId ? { ...p, strategy } : p,
          ),
        };
      });
      try {
        await client.patchProviderStrategy(providerId, { strategy });
      } catch (err) {
        setData(previous);
        notify("Failed to update rotation strategy", err);
        throw err;
      } finally {
        markSaving(key, false);
      }
    },
    [data, markSaving, notify],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const id = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [pollMs, refresh]);

  return {
    data,
    loading,
    saving,
    refresh,
    createApiKey,
    patch,
    remove,
    test,
    refreshUsage,
    setStrategy,
  };
}
