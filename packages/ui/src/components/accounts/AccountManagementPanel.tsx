/**
 * Consolidated settings surface for account-backed model providers. It keeps
 * chat keys, coding subscriptions, health, and rotation controls within the
 * Models & Providers ownership boundary.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type {
  AccountStrategy,
  AccountWithCredentialFlag,
} from "../../api/client-agent";
import { useAccounts } from "../../hooks/useAccounts";
import { cn } from "../../lib/utils";
import {
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { AccountCard } from "./AccountCard";
import {
  ACCOUNT_PROVIDER_OPTIONS,
  type AccountProviderOption,
  AddAccountDialog,
  getAccountProviderOption,
} from "./AddAccountDialog";
import { RotationStrategyPicker } from "./RotationStrategyPicker";
import { readSubscriptionOAuth } from "./subscription-oauth-state";

interface ProviderAccountGroupProps {
  option: AccountProviderOption;
  activeSubscriptionId?: SubscriptionProviderSelectionId | null;
  cloudCallsDisabled?: boolean;
  onSelectSubscription?: (
    providerId: SubscriptionProviderSelectionId,
  ) => Promise<void> | void;
  accounts: AccountWithCredentialFlag[];
  strategy?: string;
  saving: Set<string>;
  onPatch: (
    providerId: LinkedAccountProviderId,
    accountId: string,
    body: Partial<{ label: string; enabled: boolean; priority: number }>,
  ) => Promise<void>;
  onMove: (
    providerId: LinkedAccountProviderId,
    sorted: AccountWithCredentialFlag[],
    accountId: string,
    direction: "up" | "down",
  ) => Promise<void>;
  onTest: (
    providerId: LinkedAccountProviderId,
    accountId: string,
  ) => Promise<void>;
  onRefreshUsage: (
    providerId: LinkedAccountProviderId,
    accountId: string,
  ) => Promise<void>;
  onDelete: (
    providerId: LinkedAccountProviderId,
    accountId: string,
  ) => Promise<void>;
  onStrategyChange: (
    providerId: LinkedAccountProviderId,
    strategy: AccountStrategy,
  ) => void;
}

function ProviderAccountGroup({
  option,
  activeSubscriptionId,
  cloudCallsDisabled = false,
  onSelectSubscription,
  accounts,
  strategy,
  saving,
  onPatch,
  onMove,
  onTest,
  onRefreshUsage,
  onDelete,
  onStrategyChange,
}: ProviderAccountGroupProps) {
  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.priority - b.priority),
    [accounts],
  );
  const connected = sorted.length > 0;
  const healthy = sorted.filter(
    (account) => account.enabled && account.health === "ok",
  ).length;
  const needsAttention = sorted.filter(
    (account) =>
      account.health === "needs-reauth" || account.health === "invalid",
  ).length;
  const subscriptionSelection = SUBSCRIPTION_PROVIDER_SELECTIONS.find(
    (selection) => selection.storedProvider === option.id,
  );
  const isActiveSubscription =
    subscriptionSelection?.id === activeSubscriptionId;

  return (
    <section
      className={cn(
        "rounded-lg border border-border/45 bg-card/30 p-3",
        !connected && "border-dashed bg-bg-accent/25",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-txt-strong">
              {option.name}
            </h3>
            <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
              {option.category === "chat" ? "Chat" : "Code-agent"}
            </span>
            {connected ? (
              <span className="rounded-full border border-ok/35 bg-ok/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ok">
                {healthy}/{sorted.length} healthy
              </span>
            ) : (
              <span className="rounded-full border border-border/55 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                Not connected
              </span>
            )}
            {needsAttention > 0 ? (
              <span className="rounded-full border border-destructive/35 bg-destructive/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">
                {needsAttention} needs attention
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
            {option.description}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {option.eligibility.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-bg-accent px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {subscriptionSelection ? (
            <Button
              type="button"
              variant={isActiveSubscription ? "secondary" : "outline"}
              size="sm"
              className="h-8 px-2.5 text-xs"
              disabled={
                (isActiveSubscription && !cloudCallsDisabled) ||
                !onSelectSubscription
              }
              onClick={() =>
                void onSelectSubscription?.(subscriptionSelection.id)
              }
            >
              {isActiveSubscription && !cloudCallsDisabled
                ? "Active for coding"
                : "Use for coding agents"}
            </Button>
          ) : null}
          {connected ? (
            <RotationStrategyPicker
              providerId={option.id}
              value={strategy as AccountStrategy | undefined}
              onChange={(next) => onStrategyChange(option.id, next)}
              disabled={saving.has(`strategy:${option.id}`)}
            />
          ) : null}
        </div>
      </div>

      {connected ? (
        <div className="mt-3 grid gap-2">
          {sorted.map((account, index) => (
            <AccountCard
              key={account.id}
              account={account}
              isFirst={index === 0}
              isLast={index === sorted.length - 1}
              saving={saving.has(account.id)}
              testBusy={saving.has(`test:${account.id}`)}
              refreshBusy={saving.has(`usage:${account.id}`)}
              onPatch={(body) => onPatch(option.id, account.id, body)}
              onMoveUp={() => onMove(option.id, sorted, account.id, "up")}
              onMoveDown={() => onMove(option.id, sorted, account.id, "down")}
              onTest={() => onTest(option.id, account.id)}
              onRefreshUsage={() => onRefreshUsage(option.id, account.id)}
              onDelete={() => onDelete(option.id, account.id)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface AccountManagementPanelProps {
  activeSubscriptionId?: SubscriptionProviderSelectionId | null;
  cloudCallsDisabled?: boolean;
  onSelectSubscription?: (
    providerId: SubscriptionProviderSelectionId,
  ) => Promise<void> | void;
}

export function AccountManagementPanel({
  activeSubscriptionId = null,
  cloudCallsDisabled = false,
  onSelectSubscription,
}: AccountManagementPanelProps) {
  const t = useAppSelector((s) => s.t);
  const accounts = useAccounts();
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

  const providerMap = useMemo(() => {
    const map = new Map(
      accounts.data?.providers.map((provider) => [
        provider.providerId,
        provider,
      ]),
    );
    return map;
  }, [accounts.data]);

  const visibleOptions = useMemo(() => {
    const ids = new Set<LinkedAccountProviderId>(
      accounts.data?.providers.map((provider) => provider.providerId) ?? [],
    );
    for (const option of ACCOUNT_PROVIDER_OPTIONS) ids.add(option.id);
    return [...ids]
      .map((id) => getAccountProviderOption(id))
      .filter((option): option is AccountProviderOption => Boolean(option))
      .sort((left, right) => {
        if (left.category !== right.category)
          return left.category === "chat" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [accounts.data]);

  const handleMove = useCallback(
    async (
      providerId: LinkedAccountProviderId,
      sorted: AccountWithCredentialFlag[],
      accountId: string,
      direction: "up" | "down",
    ) => {
      const index = sorted.findIndex((account) => account.id === accountId);
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
      } catch (error) {
        // error-policy:J2 Restore the first priority before surfacing the reorder failure.
        try {
          await accounts.patch(providerId, self.id, {
            priority: self.priority,
          });
        } catch (rollbackError) {
          // error-policy:J2 Preserve both failures when the compensating write also fails.
          throw new AggregateError(
            [error, rollbackError],
            "Failed to reorder provider accounts and restore their priorities.",
            { cause: error },
          );
        }
        throw new Error("Failed to reorder provider accounts.", {
          cause: error,
        });
      }
    },
    [accounts],
  );

  if (accounts.loading && !accounts.data) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/45 bg-card/30 p-4 text-xs text-muted">
        <Spinner className="h-3.5 w-3.5" />
        {t("accounts.loading", { defaultValue: "Loading accounts…" })}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-txt-strong">
            {t("accounts.management.title", {
              defaultValue: "Connected accounts",
            })}
          </p>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
            {t("accounts.management.description", {
              defaultValue:
                "Keep chat API keys and coding subscriptions in one place. Chat defaults are selected above; subscription accounts are only eligible for coding agents unless marked otherwise.",
            })}
          </p>
        </div>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => {
            setPendingProviderId(undefined);
            setAddDialogOpen(true);
          }}
          className="h-9 gap-1.5 px-3 text-xs"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("accounts.add.button", { defaultValue: "Add account" })}
        </Button>
      </div>

      <div className="grid gap-2">
        {visibleOptions.map((option) => {
          const provider = providerMap.get(option.id);
          return (
            <ProviderAccountGroup
              key={option.id}
              option={option}
              activeSubscriptionId={activeSubscriptionId}
              cloudCallsDisabled={cloudCallsDisabled}
              onSelectSubscription={onSelectSubscription}
              accounts={provider?.accounts ?? []}
              strategy={provider?.strategy}
              saving={accounts.saving}
              onPatch={accounts.patch}
              onMove={handleMove}
              onTest={async (providerId, accountId) => {
                await accounts.test(providerId, accountId);
              }}
              onRefreshUsage={accounts.refreshUsage}
              onDelete={accounts.remove}
              onStrategyChange={(providerId, strategy) => {
                void accounts.setStrategy(providerId, strategy);
              }}
            />
          );
        })}
      </div>

      <AddAccountDialog
        open={addDialogOpen}
        providerId={pendingProviderId}
        onClose={() => {
          setAddDialogOpen(false);
          setPendingProviderId(undefined);
        }}
        onCreated={() => {
          void accounts.refresh();
        }}
      />
    </div>
  );
}
