/**
 * Manages provider credentials and rotation policies from the account settings
 * surface. Server-provided capability and selection metadata remain
 * authoritative; loading, empty, and failed reads render as distinct states.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type {
  AccountStrategy,
  AccountWithCredentialFlag,
} from "../../api/client-agent";
import { useAccounts } from "../../hooks/useAccounts";
import { cn } from "../../lib/utils";
import type { SubscriptionProviderSelectionId } from "../../providers";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { AddAccountDialog } from "./AddAccountDialog";
import {
  ACCOUNT_PROVIDER_OPTIONS,
  type AccountProviderOption,
  getAccountProviderOption,
} from "./account-provider-options";
import { ProviderAccountRow } from "./ProviderAccountRow";
import { readSubscriptionOAuth } from "./subscription-oauth-state";

interface AccountManagementPanelProps {
  activeSubscriptionId?: SubscriptionProviderSelectionId | null;
  activeChatProviderId?: LinkedAccountProviderId | null;
  cloudCallsDisabled?: boolean;
  onSelectChatProvider?: (providerId: LinkedAccountProviderId) => void;
  onSelectSubscription?: (
    providerId: SubscriptionProviderSelectionId,
  ) => Promise<void> | void;
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/40 px-3 py-2.5">
      <Skeleton className="h-3.5 w-3.5" />
      <Skeleton className="h-8 w-8 rounded-md" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-2.5 w-24" />
      </div>
      <Skeleton className="h-7 w-14 rounded-md" />
    </div>
  );
}

export function AccountManagementPanel({
  activeSubscriptionId = null,
  activeChatProviderId = null,
  cloudCallsDisabled = false,
  onSelectChatProvider,
  onSelectSubscription,
}: AccountManagementPanelProps) {
  const t = useAppSelector((s) => s.t);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const accounts = useAccounts({ setActionNotice });

  const [pendingProviderId, setPendingProviderId] = useState<
    LinkedAccountProviderId | undefined
  >(
    () =>
      ACCOUNT_PROVIDER_OPTIONS.find((option) =>
        readSubscriptionOAuth(option.id),
      )?.id,
  );
  const [addDialogOpen, setAddDialogOpen] = useState(() =>
    Boolean(pendingProviderId),
  );
  const [credentialRepairAccount, setCredentialRepairAccount] =
    useState<AccountWithCredentialFlag | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showAvailable, setShowAvailable] = useState(false);

  const providerMap = useMemo(() => {
    return new Map(
      accounts.data?.providers.map((p) => [p.providerId, p]) ?? [],
    );
  }, [accounts.data]);

  // Partition every known provider into connected vs available, keeping the
  // static option order but floating connected providers to the top.
  const { connectedOptions, availableOptions } = useMemo(() => {
    const all: AccountProviderOption[] = [];
    const seen = new Set<LinkedAccountProviderId>();
    for (const p of accounts.data?.providers ?? []) {
      const option = getAccountProviderOption(p.providerId);
      if (option && !seen.has(option.id)) {
        all.push(option);
        seen.add(option.id);
      }
    }
    for (const option of ACCOUNT_PROVIDER_OPTIONS) {
      if (!seen.has(option.id)) {
        all.push(option);
        seen.add(option.id);
      }
    }
    const connected: AccountProviderOption[] = [];
    const available: AccountProviderOption[] = [];
    for (const option of all) {
      const provider = providerMap.get(option.id);
      if (provider && provider.accounts.length > 0) connected.push(option);
      else available.push(option);
    }
    return { connectedOptions: connected, availableOptions: available };
  }, [accounts.data, providerMap]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openAdd = useCallback((providerId?: LinkedAccountProviderId) => {
    setCredentialRepairAccount(null);
    setPendingProviderId(providerId);
    setAddDialogOpen(true);
  }, []);

  const openCredentialRepair = useCallback(
    (
      providerId: LinkedAccountProviderId,
      account: AccountWithCredentialFlag,
    ) => {
      setCredentialRepairAccount(account);
      setPendingProviderId(providerId);
      setAddDialogOpen(true);
    },
    [],
  );

  const handleMove = useCallback(
    async (
      providerId: LinkedAccountProviderId,
      sorted: AccountWithCredentialFlag[],
      accountId: string,
      direction: "up" | "down",
    ) => {
      const index = sorted.findIndex((a) => a.id === accountId);
      const neighbourIndex = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || neighbourIndex < 0 || neighbourIndex >= sorted.length)
        return;
      const self = sorted[index];
      const neighbour = sorted[neighbourIndex];
      if (!self || !neighbour || self.priority === neighbour.priority) return;
      await accounts.patch(providerId, self.id, {
        priority: neighbour.priority,
      });
      try {
        await accounts.patch(providerId, neighbour.id, {
          priority: self.priority,
        });
      } catch (err) {
        try {
          await accounts.patch(providerId, self.id, {
            priority: self.priority,
          });
        } catch {
          await accounts.refresh();
        }
        throw err;
      }
    },
    [accounts],
  );

  const rowHandlers = {
    saving: accounts.saving,
    onPatch: accounts.patch,
    onMove: handleMove,
    onTest: async (providerId: LinkedAccountProviderId, accountId: string) => {
      await accounts.test(providerId, accountId);
    },
    onRefreshUsage: accounts.refreshUsage,
    onDelete: accounts.remove,
    onStrategyChange: (
      providerId: LinkedAccountProviderId,
      strategy: AccountStrategy,
    ) => {
      void accounts.setStrategy(providerId, strategy).catch(() => {
        // error-policy:J4 useAccounts already surfaces the rejected mutation in the settings notice.
      });
    },
    activeSubscriptionId,
    activeChatProviderId,
    cloudCallsDisabled,
    onSelectChatProvider,
    onSelectSubscription,
    onAdd: openAdd,
    onReauthenticate: openCredentialRepair,
  };

  // ── Loading skeleton (structural, matches the row layout) ──
  if (accounts.loading && !accounts.data) {
    return (
      <div className="grid gap-2" aria-busy>
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    );
  }

  // ── Explicit error + retry (never collapse into empty) ──
  if (accounts.error && !accounts.data) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-4">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            {t("accounts.error.load", {
              defaultValue: "Couldn't load your accounts.",
            })}
          </span>
        </div>
        <p className="text-xs text-muted">{accounts.error}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={() => void accounts.refresh()}
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          {t("accounts.error.retry", { defaultValue: "Retry" })}
        </Button>
      </div>
    );
  }

  const nothingConnected = connectedOptions.length === 0;

  return (
    <div className="grid gap-3">
      {/* Header: one line of intent + the primary add affordance. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-5 text-muted">
          {t("accounts.management.summary", {
            defaultValue:
              "Provider accounts feed chat and coding agents. Chat defaults are chosen in Intelligence above; here you manage the accounts behind them.",
          })}
        </p>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => openAdd(undefined)}
          className="h-8 shrink-0 gap-1.5 px-3 text-xs"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("accounts.add.button", { defaultValue: "Add account" })}
        </Button>
      </div>

      {nothingConnected ? (
        // ── Teaching empty state (not just "nothing here") ──
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/50 bg-bg-accent/20 px-6 py-8 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-accent">
            <Plus className="h-5 w-5" aria-hidden />
          </span>
          <div className="grid gap-1">
            <p className="text-sm font-medium text-txt-strong">
              {t("accounts.empty.title", {
                defaultValue: "No accounts connected yet",
              })}
            </p>
            <p className="mx-auto max-w-sm text-xs leading-5 text-muted">
              {t("accounts.empty.description", {
                defaultValue:
                  "Connect an API key for chat, or sign in to a coding subscription to power task agents. Add several to any provider and they'll rotate automatically.",
              })}
            </p>
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => openAdd(undefined)}
            className="h-8 gap-1.5 px-3 text-xs"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("accounts.empty.cta", {
              defaultValue: "Connect your first account",
            })}
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          {connectedOptions.map((option) => (
            <ProviderAccountRow
              key={option.id}
              option={option}
              provider={providerMap.get(option.id)}
              expanded={expanded.has(option.id)}
              onToggle={() => toggleExpanded(option.id)}
              {...rowHandlers}
            />
          ))}
        </div>
      )}

      {/* ── Available-to-connect disclosure (kills the empty-card stack) ── */}
      {availableOptions.length > 0 ? (
        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => setShowAvailable((v) => !v)}
            className="flex w-full items-center gap-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted transition-colors hover:text-txt-strong"
            aria-expanded={showAvailable}
          >
            <span
              className={cn(
                "inline-block transition-transform",
                showAvailable && "rotate-90",
              )}
              aria-hidden
            >
              ›
            </span>
            {nothingConnected
              ? t("accounts.available.all", {
                  defaultValue: `All providers (${availableOptions.length})`,
                  count: availableOptions.length,
                })
              : t("accounts.available.more", {
                  defaultValue: `More providers (${availableOptions.length})`,
                  count: availableOptions.length,
                })}
          </button>
          {showAvailable ? (
            <div className="grid gap-2">
              {availableOptions.map((option) => (
                <ProviderAccountRow
                  key={option.id}
                  option={option}
                  provider={providerMap.get(option.id)}
                  expanded={false}
                  onToggle={() => toggleExpanded(option.id)}
                  {...rowHandlers}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <AddAccountDialog
        open={addDialogOpen}
        providerId={pendingProviderId}
        credentialRepairAccount={credentialRepairAccount}
        onClose={() => {
          setAddDialogOpen(false);
          setPendingProviderId(undefined);
          setCredentialRepairAccount(null);
        }}
        onCreated={() => {
          void accounts.refresh();
        }}
      />
    </div>
  );
}
