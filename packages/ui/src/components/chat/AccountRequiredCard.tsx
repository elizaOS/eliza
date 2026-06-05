import { CheckCircle2, RefreshCw, ShieldAlert, UserRound } from "lucide-react";
import { useRef } from "react";
import type { ConnectorAccountRecord } from "../../api/client-agent";
import {
  type ConnectorReconnectPhase,
  useConnectorReconnect,
} from "../../hooks/useConnectorReconnect";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";
import {
  connectorAccountDisplayName,
  isConnectorAccountUsable,
} from "./connector-send-as";

export interface AccountRequiredCardProps {
  accounts: ConnectorAccountRecord[];
  className?: string;
  connectBusy?: boolean;
  confirmBusy?: boolean;
  confirmLabel?: string;
  description?: string;
  loading?: boolean;
  selectedAccount: ConnectorAccountRecord | null;
  sourceLabel?: string;
  title?: string;
  onConfirm?: () => void;
  onConnectAccount?: () => void;
  onReconnectAccount?: (accountId: string) => void;
  onSelectAccount?: (accountId: string) => void;
  /**
   * When provided, a successful reconnect auto-retries the action that hit the
   * account wall (resend the message, re-issue the write) instead of
   * dead-ending. The Reconnect button drives the reconnect → reauth → retry
   * loop and renders progress inline. Backend OAuth return is observed by
   * polling the live `accounts` prop for the account flipping to "connected".
   *
   * Omit to keep the legacy manual Reconnect button (no auto-retry).
   */
  retryAction?: () => Promise<void>;
}

function statusForAccount(account: ConnectorAccountRecord): {
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
      return { label: "Needs reauth", tone: "danger" };
    case "error":
      return { label: "Error", tone: "danger" };
    case "disconnected":
      return { label: "Disconnected", tone: "muted" };
    default:
      return { label: "Unknown", tone: "muted" };
  }
}

function ReconnectProgressLine({
  phase,
  error,
  onRetry,
}: {
  phase: ConnectorReconnectPhase;
  error: string | null;
  onRetry?: () => void;
}) {
  if (phase === "reconnecting") {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted">
        <Spinner className="h-3 w-3" />
        Waiting for sign-in to finish...
      </div>
    );
  }
  if (phase === "retrying") {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted">
        <Spinner className="h-3 w-3" />
        Reconnected. Retrying...
      </div>
    );
  }
  if (phase === "success") {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ok">
        <CheckCircle2 className="h-3 w-3" />
        Reconnected and sent.
      </div>
    );
  }
  if (phase === "failed") {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-destructive">
        <span className="min-w-0 flex-1 truncate">
          {error ?? "Reconnect failed."}
        </span>
        {onRetry ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-1.5 text-[10px]"
            onClick={onRetry}
          >
            <RefreshCw className="h-3 w-3" />
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  return null;
}

export function AccountRequiredCard({
  accounts,
  className,
  connectBusy = false,
  confirmBusy = false,
  confirmLabel = "Confirm account",
  description = "Choose the connector account Eliza should use before this write is sent.",
  loading = false,
  selectedAccount,
  sourceLabel = "connector",
  title = "Account required",
  onConfirm,
  onConnectAccount,
  onReconnectAccount,
  onSelectAccount,
  retryAction,
}: AccountRequiredCardProps) {
  // Always read the freshest account list when polling so the loop sees the
  // status flip the parent's polling source pushes in via the `accounts` prop.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const autoRetryEnabled = Boolean(retryAction && onReconnectAccount);

  const reconnectFlow = useConnectorReconnect({
    reconnect: (accountId) => {
      // The card's reconnect callback returns void (it opens the OAuth tab); the
      // hook then polls account status. Return undefined so it always polls.
      onReconnectAccount?.(accountId);
      return undefined;
    },
    pollStatus: (accountId) =>
      accountsRef.current.find((account) => account.id === accountId) ?? null,
  });

  const handleReconnect = (accountId: string) => {
    if (autoRetryEnabled && retryAction) {
      reconnectFlow.start(accountId, retryAction);
      return;
    }
    onReconnectAccount?.(accountId);
  };

  return (
    <div
      className={cn(
        "rounded-sm border border-warn/35 bg-warn/10 px-3 py-2 text-xs text-txt ",
        className,
      )}
      data-testid="account-required-card"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-txt">{title}</div>
          <div className="mt-0.5 leading-5 text-muted">{description}</div>
        </div>
      </div>

      {loading ? (
        <div className="mt-2 flex items-center gap-2 text-muted">
          <Spinner className="h-3 w-3" />
          Loading {sourceLabel} accounts...
        </div>
      ) : accounts.length > 0 ? (
        <div className="mt-2 grid gap-1.5">
          {accounts.map((account) => {
            const selected = selectedAccount?.id === account.id;
            const status = statusForAccount(account);
            const usable = isConnectorAccountUsable(account);
            const canReconnect =
              !usable &&
              (account.status === "needs-reauth" ||
                account.status === "disconnected" ||
                account.status === "error" ||
                account.enabled === false);
            const isActiveReconnect =
              reconnectFlow.activeAccountId === account.id;
            const reconnectBusy =
              autoRetryEnabled && isActiveReconnect && reconnectFlow.busy;
            const showReconnectProgress = autoRetryEnabled && isActiveReconnect;
            return (
              <div
                key={account.id}
                className={cn(
                  "min-w-0 rounded-sm border border-border/35 bg-card/45 px-2 py-1.5",
                  selected && "border-accent/60 bg-accent/8",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <UserRound className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                    disabled={!onSelectAccount}
                    onClick={() => onSelectAccount?.(account.id)}
                  >
                    <span className="block truncate font-medium text-txt">
                      {connectorAccountDisplayName(account)}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                      <StatusBadge
                        label={status.label}
                        tone={status.tone}
                        className="px-1.5 py-0 text-[9px]"
                      />
                      {account.handle || account.externalId ? (
                        <span className="truncate text-[10px] text-muted">
                          {account.handle ?? account.externalId}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {canReconnect && onReconnectAccount ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 gap-1 px-2 text-[10px]"
                      disabled={reconnectBusy}
                      onClick={() => handleReconnect(account.id)}
                    >
                      {reconnectBusy ? (
                        <Spinner className="h-3 w-3" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      Reconnect
                    </Button>
                  ) : null}
                </div>
                {showReconnectProgress ? (
                  <ReconnectProgressLine
                    phase={reconnectFlow.phase}
                    error={reconnectFlow.error}
                    onRetry={
                      retryAction
                        ? () => handleReconnect(account.id)
                        : undefined
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {onConnectAccount ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            disabled={connectBusy}
            onClick={onConnectAccount}
          >
            {connectBusy ? <Spinner className="h-3 w-3" /> : null}
            Connect account
          </Button>
        ) : null}
        {onConfirm ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-8 px-2.5 text-xs"
            disabled={confirmBusy || !selectedAccount}
            onClick={onConfirm}
          >
            {confirmBusy ? <Spinner className="h-3 w-3" /> : null}
            {confirmLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
