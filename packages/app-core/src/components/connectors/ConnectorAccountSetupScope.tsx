import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import type { ReactNode } from "react";
import { useConnectorAccounts } from "../../hooks/useConnectorAccounts";

export interface ConnectorAccountSetupScopeProps {
  provider: string;
  connectorId?: string;
  children: (accountId: string | null) => ReactNode;
}

export function ConnectorAccountSetupScope({
  provider,
  connectorId = provider,
  children,
}: ConnectorAccountSetupScopeProps) {
  const accounts = useConnectorAccounts(provider, connectorId, { pollMs: 0 });

  return (
    <>
      {accounts.accounts.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/45 bg-bg-accent/35 px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
            Setup account
          </span>
          <Select
            value={accounts.effectiveAccountId ?? undefined}
            onValueChange={(accountId) =>
              accounts.setSelectedAccountId(accountId)
            }
          >
            <SelectTrigger className="h-8 min-w-[180px] rounded-lg border border-border bg-card text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="text-sm font-medium text-txt">
                      {account.label}
                    </span>
                    {account.handle || account.externalId ? (
                      <span className="text-xs text-muted">
                        {account.handle ?? account.externalId}
                      </span>
                    ) : null}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {children(accounts.effectiveAccountId)}
    </>
  );
}
