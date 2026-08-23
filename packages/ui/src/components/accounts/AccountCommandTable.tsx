/**
 * AccountCommandTable - desktop "command center" table view for a provider's
 * account pool.
 *
 * Replaces the stacked `AccountCard`s inside an expanded provider row when the
 * viewport is desktop-width (>=1024px, matching the settings rail breakpoint)
 * AND the pool is large enough that a table earns its keep. Narrow/mobile
 * widths keep the card stack.
 *
 * Columns: account (label + email) · provider health badge (with
 * healthDetail tooltip + rate-limit countdown) · session/weekly usage bars ·
 * resets-at · priority · enabled · last-used · lease activity (feature-gated
 * on #16355 observability) · actions (reauthenticate, remove). Sortable by
 * health / usage / last-used / priority.
 *
 * Feature-detection: the lease column is only rendered when at least one row
 * carries `observability`; on older hosts (and before #16355 merges) it is
 * hidden with no layout breakage.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  KeyRound,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { useModalState } from "../../hooks/useModalState";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state/app-store";
import { formatRelativeTimeShort } from "../../utils/format";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";
import {
  type AccountSort,
  type AccountSortKey,
  DEFAULT_ACCOUNT_SORT,
  describeHealth,
  fableWeeklyBucket,
  hasLeaseObservability,
  needsCredentialRepair,
  rowResetAt,
  sortAccounts,
} from "./account-table-model";
import { formatResetIn } from "./reset-time";

type Translate = (
  key: string,
  vars?: Record<string, string | number | boolean | null | undefined>,
) => string;

export interface AccountCommandTableProps {
  providerId: LinkedAccountProviderId;
  accounts: readonly AccountWithCredentialFlag[];
  /** Explicit async states for standalone/table-level consumers. */
  loading?: boolean;
  error?: string | null;
  /** id of the account the pool will serve next (spine highlight). */
  activeAccountId?: string | null;
  saving: Set<string>;
  onPatch: (
    accountId: string,
    body: Partial<{ label: string; enabled: boolean; priority: number }>,
  ) => Promise<void>;
  onReauthenticate?: (account: AccountWithCredentialFlag) => void;
  onDelete: (accountId: string) => Promise<void>;
  /** Probe the credential. Omit to hide the per-row Test action. */
  onTest?: (accountId: string) => Promise<void>;
  /** Refresh the usage snapshot. Omit to hide the per-row Refresh action. */
  onRefreshUsage?: (accountId: string) => Promise<void>;
  /**
   * Reorder within the priority-sorted pool. `sorted` is the pool in
   * priority order (NOT the current table sort) so the swap targets the
   * correct neighbour. Omit to hide the reorder controls.
   */
  onMove?: (
    sorted: AccountWithCredentialFlag[],
    accountId: string,
    direction: "up" | "down",
  ) => Promise<void>;
}

interface UsageBarProps {
  label: string;
  pct: number | undefined;
}

function clampPct(value: number | undefined): number | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function UsageBar({ label, pct }: UsageBarProps) {
  const clamped = clampPct(pct);
  const tone =
    clamped == null
      ? "bg-muted/30"
      : clamped >= 85
        ? "bg-destructive"
        : clamped >= 60
          ? "bg-warn"
          : "bg-ok";
  return (
    <div
      className="flex items-center gap-1.5"
      title={`${label}: ${
        clamped == null ? "Unknown" : `${Math.round(clamped)}%`
      }`}
    >
      <span className="w-6 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">
        {label}
      </span>
      <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-bg-accent">
        <div
          className={cn("h-full transition-all", tone)}
          style={{ width: `${clamped ?? 0}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted">
        {clamped == null ? "Unknown" : `${Math.round(clamped)}%`}
      </span>
    </div>
  );
}

interface SortHeaderProps {
  label: string;
  columnKey: AccountSortKey;
  sort: AccountSort;
  onSort: (key: AccountSortKey) => void;
  align?: "left" | "right";
}

function SortHeader({
  label,
  columnKey,
  sort,
  onSort,
  align = "left",
}: SortHeaderProps) {
  const active = sort.key === columnKey;
  const Icon = !active
    ? ChevronsUpDown
    : sort.direction === "asc"
      ? ArrowUp
      : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(columnKey)}
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted transition-colors hover:text-txt-strong",
        align === "right" && "flex-row-reverse",
      )}
    >
      <span>{label}</span>
      <Icon
        className={cn(
          "h-3 w-3 shrink-0",
          active ? "text-txt-strong" : "text-muted/60",
        )}
        aria-hidden
      />
    </button>
  );
}

/**
 * `aria-sort` belongs on the header CELL, not the button inside it. Returns the
 * ARIA value for a given sortable column so each sortable `<th>` announces its
 * state to assistive tech.
 */
function ariaSortFor(
  sort: AccountSort,
  columnKey: AccountSortKey,
): "ascending" | "descending" | "none" {
  if (sort.key !== columnKey) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

interface HealthCellProps {
  account: AccountWithCredentialFlag;
  t: Translate;
}

function HealthCell({ account, t }: HealthCellProps) {
  const health = describeHealth(account);
  const countdown = health.until ? formatResetIn(health.until) : null;
  const label = t(health.key, { defaultValue: health.fallback });
  const tooltip = [label];
  if (countdown) tooltip.push(`resets in ${countdown}`);
  if (health.detail) tooltip.push(health.detail);
  return (
    <div className="flex flex-col gap-0.5" title={tooltip.join(" · ")}>
      <StatusBadge label={label} tone={health.tone} withDot />
      {countdown ? (
        <span className="text-[10px] tabular-nums text-warn">
          {t("accounts.table.resetsIn", {
            defaultValue: `resets in ${countdown}`,
            countdown,
          })}
        </span>
      ) : null}
    </div>
  );
}

export function AccountCommandTable({
  providerId,
  accounts,
  loading = false,
  error = null,
  activeAccountId = null,
  saving,
  onPatch,
  onReauthenticate,
  onDelete,
  onTest,
  onRefreshUsage,
  onMove,
}: AccountCommandTableProps) {
  const t = useAppSelector((s) => s.t) as Translate;
  const [sort, setSort] = useState<AccountSort>(DEFAULT_ACCOUNT_SORT);
  const deleteModal = useModalState();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const showLeaseColumn = useMemo(
    () => hasLeaseObservability(accounts),
    [accounts],
  );

  // Priority order is the pool's own ordering and the axis reorder swaps
  // operate on - kept separate from the (view-only) table sort so move
  // up/down always targets the correct neighbour even when the user has
  // sorted the table by health or usage.
  const priorityOrder = useMemo(
    () =>
      [...accounts].sort(
        (a, b) =>
          (Number.isFinite(a.priority) ? a.priority : 0) -
          (Number.isFinite(b.priority) ? b.priority : 0),
      ),
    [accounts],
  );

  const rows = useMemo(() => sortAccounts(accounts, sort), [accounts, sort]);
  const hasWindowUsage =
    providerId === "anthropic-subscription" || providerId === "openai-codex";

  const handleSort = useCallback((key: AccountSortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : {
            key,
            // Sensible initial direction per column: worst-health and
            // highest-usage first; most-recent last-used first.
            direction: key === "health" || key === "priority" ? "asc" : "desc",
          },
    );
  }, []);

  const deleteBusy = deleteModal.state.status === "submitting";
  const confirmingDelete = deleteModal.state.status !== "closed";

  const requestDelete = useCallback(
    (accountId: string) => {
      setPendingDeleteId(accountId);
      deleteModal.open();
    },
    [deleteModal],
  );

  const confirmDelete = useCallback(() => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    void deleteModal.submit(() => Promise.resolve(onDelete(id)));
  }, [deleteModal, onDelete, pendingDeleteId]);

  const runAction = useCallback((action: () => Promise<void>) => {
    setActionError(null);
    void action().catch((error: unknown) => {
      setActionError(
        error instanceof Error ? error.message : "Account action failed",
      );
    });
  }, []);

  const beginLabelEdit = useCallback((account: AccountWithCredentialFlag) => {
    setEditingLabelId(account.id);
    setLabelDraft(account.label);
  }, []);

  const finishLabelEdit = useCallback(
    (account: AccountWithCredentialFlag, save: boolean) => {
      const next = labelDraft.trim();
      setEditingLabelId(null);
      if (save && next && next !== account.label) {
        void onPatch(account.id, { label: next });
      }
    },
    [labelDraft, onPatch],
  );

  // Column count for the empty/degenerate colspan. Base columns are:
  // account, health, usage, resets, priority, enabled, last-used, actions.
  const columnCount = showLeaseColumn ? 9 : 8;

  return (
    <div
      className="overflow-x-auto rounded-sm border border-border/40"
      data-testid="account-command-table"
    >
      {actionError ? (
        <div
          className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {actionError}
        </div>
      ) : null}
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border/40 bg-bg-accent/40">
            <th scope="col" className="px-3 py-2 font-normal">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {t("accounts.table.col.account", { defaultValue: "Account" })}
              </span>
            </th>
            <th
              scope="col"
              aria-sort={ariaSortFor(sort, "health")}
              className="px-3 py-2 font-normal"
            >
              <SortHeader
                label={t("accounts.table.col.health", {
                  defaultValue: "Health",
                })}
                columnKey="health"
                sort={sort}
                onSort={handleSort}
              />
            </th>
            <th
              scope="col"
              aria-sort={ariaSortFor(sort, "usage")}
              className="px-3 py-2 font-normal"
            >
              <SortHeader
                label={t("accounts.table.col.usage", {
                  defaultValue: "Usage",
                })}
                columnKey="usage"
                sort={sort}
                onSort={handleSort}
              />
            </th>
            <th scope="col" className="px-3 py-2 font-normal">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {t("accounts.table.col.resets", { defaultValue: "Resets" })}
              </span>
            </th>
            <th
              scope="col"
              aria-sort={ariaSortFor(sort, "priority")}
              className="px-3 py-2 font-normal"
            >
              <SortHeader
                label={t("accounts.table.col.priority", {
                  defaultValue: "Priority",
                })}
                columnKey="priority"
                sort={sort}
                onSort={handleSort}
              />
            </th>
            <th scope="col" className="px-3 py-2 font-normal">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {t("accounts.table.col.enabled", { defaultValue: "Enabled" })}
              </span>
            </th>
            <th
              scope="col"
              aria-sort={ariaSortFor(sort, "lastUsed")}
              className="px-3 py-2 font-normal"
            >
              <SortHeader
                label={t("accounts.table.col.lastUsed", {
                  defaultValue: "Last used",
                })}
                columnKey="lastUsed"
                sort={sort}
                onSort={handleSort}
              />
            </th>
            {showLeaseColumn ? (
              <th scope="col" className="px-3 py-2 font-normal">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {t("accounts.table.col.leases", {
                    defaultValue: "Leases",
                  })}
                </span>
              </th>
            ) : null}
            <th scope="col" className="px-3 py-2 text-right font-normal">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                {t("accounts.table.col.actions", {
                  defaultValue: "Actions",
                })}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td
                colSpan={columnCount}
                className="px-3 py-6 text-center text-xs text-muted"
              >
                <span className="inline-flex items-center gap-2">
                  <Spinner className="h-3.5 w-3.5" />
                  {t("accounts.table.loading", {
                    defaultValue: "Loading accounts…",
                  })}
                </span>
              </td>
            </tr>
          ) : error ? (
            <tr>
              <td
                colSpan={columnCount}
                className="px-3 py-6 text-center text-xs text-destructive"
                role="alert"
              >
                {error}
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={columnCount}
                className="px-3 py-6 text-center text-xs text-muted"
              >
                {t("accounts.table.empty", {
                  defaultValue: "No accounts in this pool yet.",
                })}
              </td>
            </tr>
          ) : (
            rows.map((account) => {
              const rowSaving = saving.has(account.id);
              const isActive = account.id === activeAccountId;
              const reset = rowResetAt(account);
              const resetIn = reset ? formatResetIn(reset) : null;
              const fable = fableWeeklyBucket(account);
              const fableResetIn = fable?.resetsAt
                ? formatResetIn(fable.resetsAt)
                : null;
              const repair = needsCredentialRepair(account);
              const lease = account.observability;
              return (
                <tr
                  key={account.id}
                  data-testid={`account-row-${account.id}`}
                  data-active={isActive ? "true" : undefined}
                  className={cn(
                    "border-b border-border/25 transition-colors last:border-b-0 hover:bg-bg-accent/25",
                    !account.enabled && "bg-bg-accent/20",
                    isActive && "bg-accent/5",
                  )}
                >
                  <td className="px-3 py-2.5 align-middle">
                    <div className="flex items-center gap-2">
                      {isActive ? (
                        <span
                          className="h-4 w-0.5 shrink-0 rounded-full bg-accent"
                          aria-hidden
                          title={t("accounts.table.activeAccount", {
                            defaultValue: "Next in rotation",
                          })}
                        />
                      ) : (
                        <span className="w-0.5 shrink-0" aria-hidden />
                      )}
                      <div className="flex min-w-0 flex-col">
                        {editingLabelId === account.id ? (
                          <input
                            value={labelDraft}
                            disabled={rowSaving}
                            onChange={(event) =>
                              setLabelDraft(event.target.value)
                            }
                            onBlur={() => finishLabelEdit(account, true)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                finishLabelEdit(account, true);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                finishLabelEdit(account, false);
                              }
                            }}
                            aria-label={t("accounts.table.renameInput", {
                              defaultValue: `Rename ${account.label}`,
                              label: account.label,
                            })}
                            className="h-6 min-w-0 rounded-sm border border-border/60 bg-bg px-1.5 text-xs font-medium text-txt-strong outline-none"
                          />
                        ) : (
                          <button
                            type="button"
                            disabled={rowSaving}
                            onClick={() => beginLabelEdit(account)}
                            title={t("accounts.table.rename", {
                              defaultValue: "Rename account",
                            })}
                            className="truncate text-left text-xs font-medium text-txt-strong hover:underline"
                          >
                            {account.label}
                          </button>
                        )}
                        {account.email && account.email !== account.label ? (
                          <span
                            className="truncate text-[10px] text-muted"
                            title={account.email}
                          >
                            {account.email}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <HealthCell account={account} t={t} />
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    {hasWindowUsage ? (
                      <div className="flex flex-col gap-1">
                        <UsageBar
                          label={t("accounts.table.usage.session", {
                            defaultValue: "5h",
                          })}
                          pct={account.usage?.sessionPct}
                        />
                        <UsageBar
                          label={t("accounts.table.usage.weekly", {
                            defaultValue: "7d",
                          })}
                          pct={account.usage?.weeklyPct}
                        />
                        {providerId === "anthropic-subscription" ? (
                          <UsageBar label="Fable" pct={fable?.pct} />
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted">
                        {t("accounts.table.usage.notApplicable", {
                          defaultValue: "Not reported",
                        })}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    {hasWindowUsage ? (
                      <div className="flex flex-col gap-0.5 text-[10px] tabular-nums text-muted">
                        <span title="All-model weekly reset">
                          7d: {resetIn ?? "Unknown"}
                        </span>
                        {providerId === "anthropic-subscription" ? (
                          <span title="Fable weekly reset">
                            Fable: {fableResetIn ?? "Unknown"}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted">
                        Not reported
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <span
                      className="text-[11px] tabular-nums text-muted"
                      title={t("accounts.table.priority.tooltip", {
                        defaultValue: "Lower value runs first",
                      })}
                    >
                      #{account.priority}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <Checkbox
                      checked={account.enabled}
                      disabled={rowSaving}
                      onCheckedChange={(value) => {
                        void onPatch(account.id, {
                          enabled: value === true,
                        });
                      }}
                      aria-label={t("accounts.table.enabledToggle", {
                        defaultValue: `Toggle ${account.label}`,
                        label: account.label,
                      })}
                    />
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <span className="text-[11px] text-muted">
                      {account.lastUsedAt
                        ? formatRelativeTimeShort(account.lastUsedAt)
                        : "-"}
                    </span>
                  </td>
                  {showLeaseColumn ? (
                    <td className="px-3 py-2.5 align-middle">
                      <div className="flex flex-col gap-0.5">
                        <span
                          className={cn(
                            "text-[11px] tabular-nums",
                            lease && lease.activeLeaseCount > 0
                              ? "text-txt-strong"
                              : "text-muted",
                          )}
                          title={t("accounts.table.leases.tooltip", {
                            defaultValue: "Active leases checked out now",
                          })}
                        >
                          {lease?.activeLeaseCount ?? 0}
                        </span>
                        {lease?.servedLastRequest ? (
                          <span className="text-[9px] uppercase tracking-wider text-accent">
                            {t("accounts.table.leases.servedLast", {
                              defaultValue: "served last",
                            })}
                          </span>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5 text-right align-middle">
                    <div className="inline-flex items-center gap-1.5">
                      {onMove ? (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={
                              rowSaving || priorityOrder[0]?.id === account.id
                            }
                            onClick={() =>
                              runAction(() =>
                                onMove(priorityOrder, account.id, "up"),
                              )
                            }
                            aria-label={t("accounts.table.moveUp", {
                              defaultValue: `Raise priority of ${account.label}`,
                              label: account.label,
                            })}
                            title={t("accounts.table.moveUp.tooltip", {
                              defaultValue: "Raise priority",
                            })}
                            className="h-7 w-7 p-0"
                          >
                            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={
                              rowSaving ||
                              priorityOrder[priorityOrder.length - 1]?.id ===
                                account.id
                            }
                            onClick={() =>
                              runAction(() =>
                                onMove(priorityOrder, account.id, "down"),
                              )
                            }
                            aria-label={t("accounts.table.moveDown", {
                              defaultValue: `Lower priority of ${account.label}`,
                              label: account.label,
                            })}
                            title={t("accounts.table.moveDown.tooltip", {
                              defaultValue: "Lower priority",
                            })}
                            className="h-7 w-7 p-0"
                          >
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </>
                      ) : null}
                      {onTest ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            rowSaving || saving.has(`test:${account.id}`)
                          }
                          onClick={() => runAction(() => onTest(account.id))}
                          className="h-7 px-2 text-[11px]"
                        >
                          {saving.has(`test:${account.id}`) ? (
                            <Spinner className="h-3 w-3" />
                          ) : (
                            t("accounts.table.test", { defaultValue: "Test" })
                          )}
                        </Button>
                      ) : null}
                      {onRefreshUsage ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={
                            rowSaving || saving.has(`usage:${account.id}`)
                          }
                          onClick={() =>
                            runAction(() => onRefreshUsage(account.id))
                          }
                          aria-label={t("accounts.table.refresh", {
                            defaultValue: `Refresh usage for ${account.label}`,
                            label: account.label,
                          })}
                          title={t("accounts.table.refresh.tooltip", {
                            defaultValue: "Refresh usage",
                          })}
                          className="h-7 w-7 p-0"
                        >
                          {saving.has(`usage:${account.id}`) ? (
                            <Spinner className="h-3 w-3" />
                          ) : (
                            <RotateCw className="h-3.5 w-3.5" aria-hidden />
                          )}
                        </Button>
                      ) : null}
                      {repair && onReauthenticate ? (
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          disabled={rowSaving}
                          onClick={() => onReauthenticate(account)}
                          className="h-7 gap-1 px-2 text-[11px] text-bg"
                        >
                          <KeyRound className="h-3 w-3" aria-hidden />
                          {account.source === "oauth"
                            ? t("accounts.table.reauth", {
                                defaultValue: "Reauth",
                              })
                            : t("accounts.table.replace", {
                                defaultValue: "Replace",
                              })}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={rowSaving}
                        onClick={() => requestDelete(account.id)}
                        aria-label={t("accounts.table.remove", {
                          defaultValue: `Remove ${account.label}`,
                          label: account.label,
                        })}
                        title={t("accounts.table.remove", {
                          defaultValue: "Remove account",
                        })}
                        className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <Dialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) {
            deleteModal.close();
            setPendingDeleteId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("accounts.table.deleteConfirm.title", {
                defaultValue: "Remove this account?",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("accounts.table.deleteConfirm.description", {
                defaultValue:
                  "Removing the account deletes its stored credential and pool metadata. This cannot be undone.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={deleteBusy}
              onClick={() => {
                deleteModal.close();
                setPendingDeleteId(null);
              }}
            >
              {t("accounts.table.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteBusy}
              onClick={confirmDelete}
            >
              {deleteBusy ? (
                <Spinner className="h-3 w-3" />
              ) : (
                t("accounts.table.delete.confirm", {
                  defaultValue: "Remove account",
                })
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
