/**
 * ProviderAccountRow — one provider inside the unified Accounts surface.
 *
 * A connected provider reads as a single calm row: brand mark, name, ONE
 * status signal, capability chips, and (when the pool would rotate) a
 * "resets soonest" hint on the active account. The account detail (health,
 * usage, priority, per-account actions) is progressive-disclosure: hidden
 * until the row is expanded, so a pool of five accounts doesn't shout.
 *
 * Rotation transparency: when reset-timestamps are known the active account
 * is badged "active · resets soonest" and every account row shows "resets in
 * 2d 4h", making the selection policy legible instead of a black box.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import type { ProviderSelectionState } from "../../api/client-accounts";
import type {
  AccountStrategy,
  AccountsListProvider,
  AccountWithCredentialFlag,
} from "../../api/client-agent";
import { cn } from "../../lib/utils";
import {
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { AccountCard } from "./AccountCard";
import {
  eligibilityChips,
  providerConnectionState,
  resolveProviderEligibility,
} from "./account-eligibility";
import type { AccountProviderOption } from "./account-provider-options";
import { ProviderMark } from "./provider-icons";
import { RotationStrategyPicker } from "./RotationStrategyPicker";
import { accountResetAt, bySoonestReset, formatResetIn } from "./reset-time";

interface ProviderAccountRowProps {
  option: AccountProviderOption;
  provider?: AccountsListProvider;
  expanded: boolean;
  onToggle: () => void;
  activeSubscriptionId?: SubscriptionProviderSelectionId | null;
  activeChatProviderId?: LinkedAccountProviderId | null;
  cloudCallsDisabled?: boolean;
  onSelectChatProvider?: (providerId: LinkedAccountProviderId) => void;
  onSelectSubscription?: (
    providerId: SubscriptionProviderSelectionId,
  ) => Promise<void> | void;
  onAdd: (providerId: LinkedAccountProviderId) => void;
  onReauthenticate?: (
    providerId: LinkedAccountProviderId,
    account: AccountWithCredentialFlag,
  ) => void;
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

function StatusDot({
  state,
}: {
  state: "connected-healthy" | "connected-attention" | "disconnected";
}) {
  const tone =
    state === "connected-healthy"
      ? "bg-ok"
      : state === "connected-attention"
        ? "bg-destructive"
        : "bg-muted/40";
  return (
    <span
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)}
      aria-hidden
    />
  );
}

/**
 * Resolve the active account id + why. Prefers the server's selection state
 * (#16203). Falls back to computing "reset soonest among healthy" locally so
 * the policy is still visible on older servers.
 */
function resolveActiveSelection(
  accounts: AccountWithCredentialFlag[],
  serverSelection: ProviderSelectionState | undefined,
): { accountId: string | null; reason: ProviderSelectionState["reason"] } {
  if (serverSelection) {
    return {
      accountId: serverSelection.activeAccountId,
      reason: serverSelection.reason,
    };
  }
  const healthy = accounts.filter(
    (a) => a.enabled && (a.health === "ok" || a.health === "rate-limited"),
  );
  if (healthy.length === 0) return { accountId: null, reason: null };
  if (healthy.length === 1) {
    return { accountId: healthy[0]?.id ?? null, reason: "only-eligible" };
  }
  const anyKnownReset = healthy.some((a) => accountResetAt(a) != null);
  const ordered = [...healthy].sort(bySoonestReset);
  return {
    accountId: ordered[0]?.id ?? null,
    reason: anyKnownReset ? "reset-soonest" : "least-recently-throttled",
  };
}

const SELECTION_REASON_LABEL: Record<
  NonNullable<ProviderSelectionState["reason"]>,
  string
> = {
  "reset-soonest": "resets soonest",
  "drain-soonest-reset": "draining weekly reset",
  "only-eligible": "only account",
  priority: "highest priority",
  "round-robin": "round-robin",
  "least-used": "least used",
  "quota-aware": "most quota",
  "least-recently-throttled": "least recently used",
};

export function ProviderAccountRow({
  option,
  provider,
  expanded,
  onToggle,
  activeSubscriptionId,
  activeChatProviderId,
  cloudCallsDisabled = false,
  onSelectChatProvider,
  onSelectSubscription,
  onAdd,
  onReauthenticate,
  saving,
  onPatch,
  onMove,
  onTest,
  onRefreshUsage,
  onDelete,
  onStrategyChange,
}: ProviderAccountRowProps) {
  const t = useAppSelector((s) => s.t);
  const accounts = provider?.accounts ?? [];
  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.priority - b.priority),
    [accounts],
  );
  const connected = sorted.length > 0;
  const connState = providerConnectionState(sorted);
  const healthy = sorted.filter((a) => a.enabled && a.health === "ok").length;
  const eligibility = resolveProviderEligibility(
    option,
    provider?.runtimeEligibility,
  );
  const chips = eligibilityChips(eligibility);

  const selection = resolveActiveSelection(sorted, provider?.selection);
  const activeAccount = sorted.find((a) => a.id === selection.accountId);
  const activeResetIn = activeAccount
    ? formatResetIn(accountResetAt(activeAccount))
    : null;

  const subscriptionSelection = SUBSCRIPTION_PROVIDER_SELECTIONS.find(
    (s) => s.storedProvider === option.id,
  );
  const isActiveSubscription =
    subscriptionSelection?.id === activeSubscriptionId;
  const isDirectChatProvider = option.category === "chat";
  const isActiveChatProvider = option.id === activeChatProviderId;

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        connected
          ? "border-border/50 bg-card/40"
          : "border-dashed border-border/40 bg-transparent",
      )}
    >
      {/* ── Header row: the single calm summary line ── */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          disabled={!connected}
          aria-expanded={connected ? expanded : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 rounded-md text-left",
            connected ? "cursor-pointer" : "cursor-default",
          )}
        >
          {connected ? (
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted transition-transform",
                expanded && "rotate-90",
              )}
              aria-hidden
            />
          ) : (
            <span className="w-3.5 shrink-0" aria-hidden />
          )}
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
              connected
                ? "border-border/50 bg-bg-accent text-txt-strong"
                : "border-border/40 bg-bg-accent/40 text-muted",
            )}
          >
            <ProviderMark
              providerId={option.id}
              className="h-4 w-4"
              title={option.name}
            />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-txt-strong">
                {option.name}
              </span>
              {connected ? (
                <span className="flex items-center gap-1.5 text-[11px] text-muted">
                  <StatusDot state={connState} />
                  {connState === "connected-attention"
                    ? t("accounts.row.attention", {
                        defaultValue: "Needs attention",
                      })
                    : t("accounts.row.healthy", {
                        defaultValue: `${healthy}/${sorted.length} healthy`,
                        healthy,
                        total: sorted.length,
                      })}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {chips.map((chip) => (
                <span
                  key={chip.key}
                  className={cn(
                    "rounded px-1.5 py-px text-[10px] font-medium",
                    chip.tone === "chat" &&
                      "bg-accent-subtle text-accent-muted",
                    chip.tone === "coding" && "bg-bg-accent text-muted-strong",
                    chip.tone === "muted" && "bg-bg-accent text-muted",
                  )}
                >
                  {chip.label}
                </span>
              ))}
              {connected && activeAccount && selection.reason ? (
                <span
                  className="text-[10px] text-muted"
                  title={t("accounts.row.selectionTooltip", {
                    defaultValue:
                      "The pool serves this account next. Reset-soonest spends the budget that refunds first.",
                  })}
                >
                  {t("accounts.row.activeReason", {
                    defaultValue: `active · ${
                      SELECTION_REASON_LABEL[selection.reason]
                    }`,
                    reason: SELECTION_REASON_LABEL[selection.reason],
                  })}
                  {activeResetIn
                    ? t("accounts.row.activeResetIn", {
                        defaultValue: ` · resets in ${activeResetIn}`,
                        resetIn: activeResetIn,
                      })
                    : ""}
                </span>
              ) : null}
            </span>
          </span>
        </button>

        {/* Right-aligned inline actions — no separate modal world. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {connected && isDirectChatProvider ? (
            <Button
              type="button"
              variant={isActiveChatProvider ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={isActiveChatProvider || !onSelectChatProvider}
              onClick={() => onSelectChatProvider?.(option.id)}
              title={t("accounts.row.useForChat.tooltip", {
                defaultValue: "Route chat through this provider account pool",
              })}
            >
              {isActiveChatProvider
                ? t("accounts.row.chatActive", { defaultValue: "Chat" })
                : t("accounts.row.useForChat", {
                    defaultValue: "Use for chat",
                  })}
            </Button>
          ) : null}
          {subscriptionSelection ? (
            <Button
              type="button"
              variant={isActiveSubscription ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={
                (isActiveSubscription && !cloudCallsDisabled) ||
                !onSelectSubscription
              }
              onClick={() =>
                void onSelectSubscription?.(subscriptionSelection.id)
              }
              title={t("accounts.row.useForCoding.tooltip", {
                defaultValue: "Route coding agents through this subscription",
              })}
            >
              {isActiveSubscription && !cloudCallsDisabled
                ? t("accounts.row.codingActive", { defaultValue: "Coding" })
                : t("accounts.row.useForCoding", {
                    defaultValue: "Use for coding",
                  })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted hover:text-txt-strong"
            onClick={() => onAdd(option.id)}
          >
            {connected
              ? t("accounts.row.addAnother", { defaultValue: "Add" })
              : t("accounts.row.connect", { defaultValue: "Connect" })}
          </Button>
        </div>
      </div>

      {/* ── Expanded detail: accounts + rotation strategy ── */}
      {connected && expanded ? (
        <div className="grid gap-2 border-t border-border/40 px-3 pb-3 pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
              {t("accounts.row.accountsLabel", {
                defaultValue: "Accounts in pool",
              })}
            </span>
            <RotationStrategyPicker
              providerId={option.id}
              value={provider?.strategy as AccountStrategy | undefined}
              onChange={(next) => onStrategyChange(option.id, next)}
              disabled={saving.has(`strategy:${option.id}`)}
            />
          </div>
          <div className="grid gap-2">
            {sorted.map((account, index) => (
              <div key={account.id} className="relative">
                {account.id === selection.accountId ? (
                  <span
                    className="absolute -left-px top-3 h-6 w-0.5 rounded-full bg-accent"
                    aria-hidden
                    title={t("accounts.row.activeAccount", {
                      defaultValue: "Next in rotation",
                    })}
                  />
                ) : null}
                <AccountCard
                  account={account}
                  isFirst={index === 0}
                  isLast={index === sorted.length - 1}
                  saving={saving.has(account.id)}
                  testBusy={saving.has(`test:${account.id}`)}
                  refreshBusy={saving.has(`usage:${account.id}`)}
                  onPatch={(body) => onPatch(option.id, account.id, body)}
                  onMoveUp={() => onMove(option.id, sorted, account.id, "up")}
                  onMoveDown={() =>
                    onMove(option.id, sorted, account.id, "down")
                  }
                  onTest={() => onTest(option.id, account.id)}
                  onRefreshUsage={() => onRefreshUsage(option.id, account.id)}
                  onDelete={() => onDelete(option.id, account.id)}
                  onReauthenticate={
                    onReauthenticate
                      ? () => onReauthenticate(option.id, account)
                      : undefined
                  }
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
