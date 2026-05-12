import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";
import { Plus } from "lucide-react";
import { useEffect, useMemo } from "react";
import type {
  ConnectorAccountCreateInput,
  ConnectorAccountRecord,
} from "../../api/client-agent";
import { useConnectorAccounts } from "../../hooks/useConnectorAccounts";
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

export function ConnectorAccountList({
  provider,
  connectorId = provider,
  title = "Connector accounts",
  className,
  pollMs,
  selectedAccountId,
  onSelectedAccountIdChange,
  onAddAccount,
}: ConnectorAccountListProps) {
  const connectorAccounts = useConnectorAccounts(provider, connectorId, {
    pollMs,
    initialSelectedAccountId: selectedAccountId,
  });
  const setConnectorSelectedAccountId = connectorAccounts.setSelectedAccountId;

  useEffect(() => {
    if (selectedAccountId !== undefined) {
      setConnectorSelectedAccountId(selectedAccountId);
    }
  }, [selectedAccountId, setConnectorSelectedAccountId]);

  const sortedAccounts = useMemo(
    () =>
      sortConnectorAccounts(
        connectorAccounts.accounts,
        connectorAccounts.defaultAccountId,
      ),
    [connectorAccounts.accounts, connectorAccounts.defaultAccountId],
  );

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
    const result = await connectorAccounts.startOAuth({
      metadata: {
        requestedRole: "OWNER",
        privacy: "owner_only",
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
        "mt-3 flex flex-col gap-2 rounded-xl border border-border/40 bg-bg-accent/40 p-3",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {title} ({sortedAccounts.length})
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
