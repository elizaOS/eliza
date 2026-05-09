import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
  StatusBadge,
} from "@elizaos/ui";
import { Check, ChevronDown, RefreshCw, UserRound } from "lucide-react";
import type { ConnectorAccountRecord } from "../../api/client-agent";
import {
  connectorAccountDisplayName,
  isConnectorAccountUsable,
} from "./connector-send-as";

export interface ConnectorAccountPickerProps {
  accounts: ConnectorAccountRecord[];
  className?: string;
  connectBusy?: boolean;
  disabled?: boolean;
  loading?: boolean;
  selectedAccount: ConnectorAccountRecord | null;
  sourceLabel?: string;
  show?: boolean;
  onConnectAccount?: () => void;
  onReconnectAccount?: (accountId: string) => void;
  onSelectAccount: (accountId: string) => void;
}

function accountStatusLabel(account: ConnectorAccountRecord): {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
} {
  if (account.enabled === false) return { label: "Disabled", tone: "muted" };
  switch (account.status) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "pending":
      return { label: "Pending", tone: "warning" };
    case "needs-reauth":
      return { label: "Reconnect", tone: "danger" };
    case "error":
      return { label: "Error", tone: "danger" };
    case "disconnected":
      return { label: "Disconnected", tone: "muted" };
    default:
      return { label: "Unknown", tone: "muted" };
  }
}

function accountSecondaryText(account: ConnectorAccountRecord): string {
  return (
    account.handle?.trim() ||
    account.externalId?.trim() ||
    account.statusDetail?.trim() ||
    account.id
  );
}

export function ConnectorAccountPicker({
  accounts,
  className,
  connectBusy = false,
  disabled = false,
  loading = false,
  selectedAccount,
  sourceLabel = "Connector",
  show = true,
  onConnectAccount,
  onReconnectAccount,
  onSelectAccount,
}: ConnectorAccountPickerProps) {
  if (!show) return null;

  const selectedName = selectedAccount
    ? connectorAccountDisplayName(selectedAccount)
    : loading
      ? "Loading"
      : "Choose account";
  const selectedStatus = selectedAccount
    ? accountStatusLabel(selectedAccount)
    : null;

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || loading}
            className="h-7 max-w-full rounded-full px-2 text-[11px] shadow-none"
            data-testid="connector-account-picker-trigger"
          >
            {loading ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <UserRound className="h-3.5 w-3.5" aria-hidden />
            )}
            <span className="min-w-0 truncate">
              {sourceLabel}: {selectedName}
            </span>
            {selectedStatus ? (
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  selectedStatus.tone === "success"
                    ? "bg-ok"
                    : selectedStatus.tone === "warning"
                      ? "bg-warn"
                      : selectedStatus.tone === "danger"
                        ? "bg-destructive"
                        : "bg-muted",
                )}
                aria-hidden
              />
            ) : null}
            <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-72 max-w-[calc(100vw-2rem)]"
        >
          <DropdownMenuLabel className="text-xs text-muted">
            Send as
          </DropdownMenuLabel>
          {accounts.map((account) => {
            const selected = selectedAccount?.id === account.id;
            const status = accountStatusLabel(account);
            const needsReconnect =
              account.status === "needs-reauth" ||
              account.status === "disconnected" ||
              account.status === "error" ||
              account.enabled === false;
            return (
              <DropdownMenuItem
                key={account.id}
                className="items-start gap-2 py-2"
                onSelect={(event) => {
                  event.preventDefault();
                  onSelectAccount(account.id);
                }}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {selected ? <Check className="h-3.5 w-3.5" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium">
                      {connectorAccountDisplayName(account)}
                    </span>
                    {account.isDefault ? (
                      <span className="rounded-sm border border-border/40 px-1 py-0 text-[9px] uppercase text-muted">
                        Default
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-1.5">
                    <StatusBadge
                      label={status.label}
                      tone={status.tone}
                      className="px-1.5 py-0 text-[9px]"
                    />
                    <span className="truncate text-[10px] text-muted">
                      {accountSecondaryText(account)}
                    </span>
                  </span>
                </span>
                {needsReconnect && onReconnectAccount ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 shrink-0 p-0"
                    title="Reconnect account"
                    aria-label={`Reconnect ${connectorAccountDisplayName(account)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onReconnectAccount(account.id);
                    }}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </DropdownMenuItem>
            );
          })}
          {onConnectAccount ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="py-2 text-xs"
                disabled={connectBusy}
                onSelect={(event) => {
                  event.preventDefault();
                  onConnectAccount();
                }}
              >
                {connectBusy ? <Spinner className="h-3 w-3" /> : null}
                Connect another account
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {selectedAccount && !isConnectorAccountUsable(selectedAccount) ? (
        <span className="truncate text-[11px] text-warn">
          Account needs attention
        </span>
      ) : null}
    </div>
  );
}
