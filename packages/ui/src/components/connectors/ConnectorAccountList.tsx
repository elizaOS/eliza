import { Plus } from "lucide-react";
import { useEffect, useMemo } from "react";
import type {
  ConnectorAccountCreateInput,
  ConnectorAccountRecord,
  ConnectorAccountRole,
} from "../../api/client-agent";
import {
  type UseConnectorAccountsResult,
  useConnectorAccounts,
} from "../../hooks/useConnectorAccounts";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { ConnectorAccountCard } from "./ConnectorAccountCard";

export interface ConnectorAccountListProps {
  provider: string;
  connectorId?: string;
  title?: string;
  className?: string;
  pollMs?: number;
  selectedAccountId?: string | null;
  onSelectedAccountIdChange?: (accountId: string | null) => void;
  onAddAccount?: () =>
    | Promise<ConnectorAccountCreateInput | undefined>
    | ConnectorAccountCreateInput
    | undefined;
  /**
   * When set, this list represents accounts for a single connector role:
   * `OWNER` shows only the user's own account(s); `AGENT` shows only the
   * agent's separate identity account(s). Filters the rendered accounts and
   * threads the role into the OAuth start request so the cloud stores the
   * resulting connection under the correct role. When omitted, the legacy
   * "single flat list of accounts" behavior is preserved.
   */
  accountRole?: ConnectorAccountRole;
  /**
   * Optional pre-built `useConnectorAccounts` result. When provided, the
   * component reuses this external hook state instead of instantiating its
   * own — used by `OwnerAgentConnectorSetupPanel` to share a single polling
   * instance across the OWNER and AGENT sections. The list still filters
   * the shared `accounts` array by `accountRole` locally.
   *
   * When omitted, the list calls `useConnectorAccounts` internally as
   * before, preserving the legacy single-list behavior.
   */
  externalAccounts?: UseConnectorAccountsResult;
}

function sortConnectorAccounts(
  accounts: ConnectorAccountRecord[],
  defaultAccountId: string | null,
): ConnectorAccountRecord[] {
  return [...accounts].sort((a, b) => {
    const aDefault =
      a.id === defaultAccountId ||
      (defaultAccountId === null &&
        a.isDefault === true &&
        a.enabled !== false &&
        a.status === "connected");
    const bDefault =
      b.id === defaultAccountId ||
      (defaultAccountId === null &&
        b.isDefault === true &&
        b.enabled !== false &&
        b.status === "connected");
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

function openConnectorAuthUrl(authUrl: string | undefined): void {
  if (!authUrl || typeof window === "undefined") return;
  window.open(authUrl, "_blank", "noopener,noreferrer");
}

function defaultTitleForRole(role: ConnectorAccountRole | undefined): string {
  switch (role) {
    case "OWNER":
      return "Owner accounts";
    case "AGENT":
      return "Agent accounts";
    case "TEAM":
      return "Team accounts";
    default:
      return "Connector accounts";
  }
}

export function ConnectorAccountList({
  provider,
  connectorId = provider,
  title,
  className,
  pollMs,
  selectedAccountId,
  onSelectedAccountIdChange,
  onAddAccount,
  accountRole,
  externalAccounts,
}: ConnectorAccountListProps) {
  // When the caller hoists the accounts hook (e.g. `OwnerAgentConnectorSetupPanel`),
  // skip the internal polling instance — Rules of Hooks require the call
  // unconditionally, but `enabled: false` disables the network fetch + interval.
  const internalAccounts = useConnectorAccounts(provider, connectorId, {
    pollMs,
    initialSelectedAccountId: selectedAccountId,
    enabled: !externalAccounts,
  });
  const connectorAccounts = externalAccounts ?? internalAccounts;
  const setConnectorSelectedAccountId = connectorAccounts.setSelectedAccountId;
  const effectiveTitle = title ?? defaultTitleForRole(accountRole);

  useEffect(() => {
    if (selectedAccountId !== undefined) {
      setConnectorSelectedAccountId(selectedAccountId);
    }
  }, [selectedAccountId, setConnectorSelectedAccountId]);

  const sortedAccounts = useMemo(() => {
    const filtered = accountRole
      ? connectorAccounts.accounts.filter(
          (account) => account.role === accountRole,
        )
      : connectorAccounts.accounts;
    return sortConnectorAccounts(filtered, connectorAccounts.defaultAccountId);
  }, [
    connectorAccounts.accounts,
    connectorAccounts.defaultAccountId,
    accountRole,
  ]);

  const handleSelect = (accountId: string) => {
    setConnectorSelectedAccountId(accountId);
    onSelectedAccountIdChange?.(accountId);
  };

  const handleAdd = async () => {
    if (onAddAccount) {
      const body = await onAddAccount();
      if (!body) return;
      await connectorAccounts.add(body);
      return;
    }
    const requestedRole: ConnectorAccountRole = accountRole ?? "OWNER";
    const result = await connectorAccounts.startOAuth({
      metadata: {
        requestedRole,
        privacy: requestedRole === "OWNER" ? "owner_only" : "team_visible",
      },
    });
    openConnectorAuthUrl(result.authUrl);
  };

  const addBusy =
    connectorAccounts.saving.has(`add:${provider}:${connectorId}`) ||
    connectorAccounts.saving.has(`oauth:${provider}:${connectorId}:new`);

  return (
    <div
      className={cn(
        "mt-3 flex flex-col gap-2 rounded-sm border border-border/40 bg-bg-accent/40 p-3",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {effectiveTitle} ({sortedAccounts.length})
        </h3>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={addBusy}
          onClick={() => void handleAdd()}
          className="h-8 gap-1 px-2.5 text-xs"
        >
          {addBusy ? (
            <Spinner className="h-3 w-3" />
          ) : (
            <Plus className="h-3.5 w-3.5" aria-hidden />
          )}
          Add account
        </Button>
      </div>

      {connectorAccounts.loading && !connectorAccounts.data ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3 w-3" />
          Loading connector accounts...
        </div>
      ) : null}

      {connectorAccounts.error ? (
        <div className="rounded-lg border border-border/45 bg-card/30 px-3 py-2 text-xs text-muted">
          {connectorAccounts.error}
        </div>
      ) : null}

      {sortedAccounts.length === 0 && !connectorAccounts.loading ? (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-6 text-center text-xs text-muted">
          No connector accounts yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sortedAccounts.map((account) => {
            const isDefault =
              account.id === connectorAccounts.defaultAccountId ||
              (connectorAccounts.defaultAccountId === null &&
                account.isDefault === true &&
                account.enabled !== false &&
                account.status === "connected");
            return (
              <ConnectorAccountCard
                key={account.id}
                account={account}
                isDefault={isDefault}
                selected={
                  account.id === connectorAccounts.effectiveAccountId ||
                  account.id === selectedAccountId
                }
                saving={connectorAccounts.saving.has(account.id)}
                testBusy={connectorAccounts.saving.has(`test:${account.id}`)}
                refreshBusy={connectorAccounts.saving.has(
                  `refresh:${account.id}`,
                )}
                onSelect={() => handleSelect(account.id)}
                onUpdate={async (body) => {
                  await connectorAccounts.update(account.id, body);
                }}
                onTest={async () => {
                  await connectorAccounts.test(account.id);
                }}
                onRefresh={async () => {
                  await connectorAccounts.refreshAccount(account.id);
                }}
                onDelete={async () => {
                  await connectorAccounts.remove(account.id);
                }}
                onMakeDefault={async () => {
                  await connectorAccounts.makeDefault(account.id);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
