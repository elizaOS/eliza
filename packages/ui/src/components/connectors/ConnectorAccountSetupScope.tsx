/**
 * Account-scoping wrapper for connector setup flows: renders a selector of the
 * connector's usable (connected, enabled) accounts and calls its render-prop
 * child with the chosen account id, so a setup panel can scope its actions to a
 * single account. Backed by the `useConnectorAccounts` hook.
 */

import type { ReactNode } from "react";
import type { ConnectorAccountRecord } from "../../api/client-agent";
import { useConnectorAccounts } from "../../hooks/useConnectorAccounts";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Badge } from "../ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export interface ConnectorAccountSetupScopeProps {
  provider: string;
  connectorId?: string;
  children: (accountId: string | null) => ReactNode;
}

function canUseSetupAccount(account: ConnectorAccountRecord): boolean {
  return account.enabled !== false && account.status === "connected";
}

function formatPrivacy(value: string | undefined): string {
  return (value ?? "owner_only").replace(/_/g, " ");
}

export function ConnectorAccountSetupScope({
  provider,
  connectorId = provider,
  children,
}: ConnectorAccountSetupScopeProps) {
  const { t } = useTranslation();
  const accounts = useConnectorAccounts(provider, connectorId, { pollMs: 0 });
  const selectedAccount =
    accounts.accounts.find(
      (account) => account.id === accounts.effectiveAccountId,
    ) ?? null;
  const selectedSetupAccountId =
    selectedAccount && canUseSetupAccount(selectedAccount)
      ? selectedAccount.id
      : null;

  return (
    <>
      {accounts.accounts.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-sm border border-border/45 bg-bg-accent/35 px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
            {t("connectorsetupscope.setupAccount", {
              defaultValue: "Setup account",
            })}
          </span>
          <Select
            value={selectedSetupAccountId ?? undefined}
            onValueChange={(accountId) => {
              const account = accounts.accounts.find(
                (item) => item.id === accountId,
              );
              if (!account || !canUseSetupAccount(account)) return;
              accounts.setSelectedAccountId(accountId);
            }}
          >
            <SelectTrigger className="h-8 min-w-[180px] rounded-sm border border-border bg-card text-xs">
              <SelectValue
                placeholder={t("connectorsetupscope.choosePlaceholder", {
                  defaultValue: "Choose account",
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {accounts.accounts.map((account) => {
                const usable = canUseSetupAccount(account);
                return (
                  <SelectItem
                    key={account.id}
                    value={account.id}
                    disabled={!usable}
                  >
                    <div className="flex flex-col gap-0.5 py-0.5">
                      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-txt">
                        <span className="truncate">{account.label}</span>
                        <Badge
                          variant="outline"
                          className="text-[9px] uppercase"
                        >
                          {account.role}
                        </Badge>
                      </span>
                      {account.handle || account.externalId ? (
                        <span className="text-xs text-muted">
                          {account.handle ?? account.externalId}
                        </span>
                      ) : null}
                      <span className="text-[10px] capitalize text-muted">
                        {account.status}
                        {usable
                          ? ""
                          : t("connectorsetupscope.unavailableSuffix", {
                              defaultValue: " unavailable",
                            })}{" "}
                        · {formatPrivacy(account.privacy)}
                      </span>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {!selectedSetupAccountId ? (
            <span className="text-xs text-warn">
              {t("connectorsetupscope.chooseConnected", {
                defaultValue: "Choose a connected account to continue.",
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      {children(selectedSetupAccountId)}
    </>
  );
}
