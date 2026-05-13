/**
 * AccountCard — single account row inside an AccountList.
 *
 * Renders the credential's health glyph, label (inline-editable), source
 * badge, priority controls (up/down arrows — no drag-drop dependency),
 * usage bars (Anthropic shows session + weekly, Codex shows session
 * only), enabled toggle, Test/Refresh/Delete actions, and a confirm
 * dialog for delete.
 */

import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { useModalState } from "../../hooks/useModalState";
import { cn } from "../../lib/utils";
import { useApp } from "../../state";
import { Badge } from "../ui/badge";
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
import { EditableAccountLabel } from "./EditableAccountLabel";

export interface AccountCardProps {
  account: AccountWithCredentialFlag;
  isFirst: boolean;
  isLast: boolean;
  saving: boolean;
  onPatch: (
    body: Partial<{ label: string; enabled: boolean; priority: number }>,
  ) => Promise<void>;
  onMoveUp: () => Promise<void>;
  onMoveDown: () => Promise<void>;
  onTest: () => Promise<void>;
  onRefreshUsage: () => Promise<void>;
  onDelete: () => Promise<void>;
  testBusy?: boolean;
  refreshBusy?: boolean;
}

function formatRelativeTime(epochMs: number | undefined): string {
  if (!epochMs) return "—";
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatResetIn(epochMs: number | undefined): string | null {
  if (!epochMs) return null;
  const diff = epochMs - Date.now();
  if (diff <= 0) return null;
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function clampPct(value: number | undefined): number | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

interface UsageBarProps {
  label: string;
  pct: number | undefined;
  resetsAt?: number;
}

function UsageBar({ label, pct, resetsAt }: UsageBarProps) {
  const clamped = clampPct(pct);
  const resetIn = formatResetIn(resetsAt);
  const tone =
    clamped == null
      ? "bg-muted/30"
      : clamped >= 85
        ? "bg-destructive"
        : clamped >= 60
          ? "bg-warn"
          : "bg-ok";

  const titleParts = [
    `${label}: ${clamped == null ? "—" : `${Math.round(clamped)}%`}`,
  ];
  if (resetIn) titleParts.push(`resets in ${resetIn}`);

  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      title={titleParts.join(" · ")}
    >
      <span className="w-9 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">
        {label}
      </span>
      <div className="relative h-1.5 min-w-[48px] flex-1 overflow-hidden rounded-full bg-bg-accent">
        <div
          className={cn("h-full transition-all", tone)}
          style={{ width: `${clamped ?? 0}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted">
        {clamped == null ? "—" : `${Math.round(clamped)}%`}
      </span>
    </div>
  );
}

interface HealthLabelInfo {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
}

function deriveHealthLabel(
  account: AccountWithCredentialFlag,
  t: (k: string, v?: Record<string, unknown>) => string,
): HealthLabelInfo {
  switch (account.health) {
    case "ok":
      return {
        label: t("accounts.health.ok", { defaultValue: "Healthy" }),
        tone: "success",
      };
    case "rate-limited": {
      const resetIn = formatResetIn(account.healthDetail?.until);
      return {
        label: resetIn
          ? t("accounts.health.rateLimitedWithReset", {
              defaultValue: `Rate-limited (resets in ${resetIn})`,
              resetIn,
            })
          : t("accounts.health.rateLimited", {
              defaultValue: "Rate-limited",
            }),
        tone: "warning",
      };
    }
    case "needs-reauth":
      return {
        label: t("accounts.health.needsReauth", {
          defaultValue: "Needs reauth",
        }),
        tone: "danger",
      };
    case "invalid":
      return {
        label: t("accounts.health.invalid", {
          defaultValue: "Invalid credential",
        }),
        tone: "danger",
      };
    default:
      return {
        label: t("accounts.health.unknown", { defaultValue: "Unknown" }),
        tone: "muted",
      };
  }
}

export function AccountCard({
  account,
  isFirst,
  isLast,
  saving,
  onPatch,
  onMoveUp,
  onMoveDown,
  onTest,
  onRefreshUsage,
  onDelete,
  testBusy = false,
  refreshBusy = false,
}: AccountCardProps) {
  const { t } = useApp();
  const deleteModal = useModalState();
  const deleteBusy = deleteModal.state.status === "submitting";
  const confirmingDelete = deleteModal.state.status !== "closed";

  const handleConfirmDelete = () => {
    void deleteModal.submit(() => Promise.resolve(onDelete()));
  };

  const health = deriveHealthLabel(account, t);
  const isAnthropic = account.providerId === "anthropic-subscription";
  const isCodex = account.providerId === "openai-codex";
  const isCodingPlan =
    account.providerId === "zai-coding" || account.providerId === "kimi-coding";
  const usage = account.usage;
  const lastUsed = formatRelativeTime(account.lastUsedAt);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border/45 bg-card/35 px-3 py-2.5 transition-opacity",
        !account.enabled && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StatusBadge label={health.label} tone={health.tone} withDot />
          <EditableAccountLabel
            value={account.label}
            onSubmit={(label) => onPatch({ label })}
            disabled={saving}
            inputAriaLabel={t("accounts.label.edit", {
              defaultValue: "Account label",
            })}
            editTitle={t("accounts.label.editTooltip", {
              defaultValue: "Click to rename",
            })}
          />
          <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
            {isCodingPlan
              ? t("accounts.source.codingPlan", {
                  defaultValue: "Coding plan",
                })
              : account.source === "oauth"
                ? t("accounts.source.oauth", { defaultValue: "OAuth" })
                : t("accounts.source.apiKey", { defaultValue: "API key" })}
          </Badge>
          <span
            className="shrink-0 text-[10px] tabular-nums text-muted"
            title={t("accounts.priority.tooltip", {
              defaultValue: "Lower priority value runs first",
            })}
          >
            #{account.priority}
          </span>
          <span className="shrink-0 text-[10px] text-muted">
            {t("accounts.lastUsed", {
              defaultValue: `Last used ${lastUsed}`,
              lastUsed,
            })}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isFirst || saving}
            onClick={() => void onMoveUp()}
            aria-label={t("accounts.moveUp", { defaultValue: "Move up" })}
            title={t("accounts.moveUp", { defaultValue: "Move up" })}
            className="h-7 w-7 p-0"
          >
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isLast || saving}
            onClick={() => void onMoveDown()}
            aria-label={t("accounts.moveDown", { defaultValue: "Move down" })}
            title={t("accounts.moveDown", { defaultValue: "Move down" })}
            className="h-7 w-7 p-0"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <div className="ml-1 inline-flex items-center gap-1.5 text-xs text-muted">
            <Checkbox
              checked={account.enabled}
              disabled={saving}
              onCheckedChange={(value) => {
                void onPatch({ enabled: value === true });
              }}
              aria-label={t("accounts.enabledToggle", {
                defaultValue: "Account enabled",
              })}
            />
            {t("accounts.enabled", { defaultValue: "Enabled" })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={testBusy || saving}
            onClick={() => void onTest()}
            className="h-7 px-2 text-xs"
          >
            {testBusy ? (
              <Spinner className="h-3 w-3" />
            ) : (
              t("accounts.test", { defaultValue: "Test" })
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshBusy || saving}
            onClick={() => void onRefreshUsage()}
            className="h-7 px-2 text-xs"
          >
            {refreshBusy ? (
              <Spinner className="h-3 w-3" />
            ) : (
              t("accounts.refresh", { defaultValue: "Refresh" })
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={deleteModal.open}
            aria-label={t("accounts.delete", {
              defaultValue: "Delete account",
            })}
            title={t("accounts.delete", { defaultValue: "Delete account" })}
            className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {isAnthropic ? (
          <>
            <UsageBar
              label={t("accounts.usage.session5h", { defaultValue: "5h" })}
              pct={usage?.sessionPct}
              resetsAt={usage?.resetsAt}
            />
            <UsageBar
              label={t("accounts.usage.weekly", { defaultValue: "7d" })}
              pct={usage?.weeklyPct}
              resetsAt={usage?.resetsAt}
            />
          </>
        ) : isCodex ? (
          <UsageBar
            label={t("accounts.usage.session", { defaultValue: "Session" })}
            pct={usage?.sessionPct}
            resetsAt={usage?.resetsAt}
          />
        ) : usage ? (
          <UsageBar
            label={t("accounts.usage.session", { defaultValue: "Session" })}
            pct={usage.sessionPct}
            resetsAt={usage.resetsAt}
          />
        ) : (
          <span className="text-xs text-muted">
            {t("accounts.usage.none", {
              defaultValue: "No usage data yet — click Refresh to probe.",
            })}
          </span>
        )}
        {!account.hasCredential ? (
          <span
            className="text-[10px] text-warn"
            title={t("accounts.orphan.tooltip", {
              defaultValue:
                "Pool metadata exists but no on-disk credential was found.",
            })}
          >
            {t("accounts.orphan.label", {
              defaultValue: "Orphan metadata",
            })}
          </span>
        ) : null}
      </div>

      <Dialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) deleteModal.close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("accounts.deleteConfirm.title", {
                defaultValue: "Remove this account?",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("accounts.deleteConfirm.description", {
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
              onClick={deleteModal.close}
            >
              {t("accounts.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteBusy}
              onClick={handleConfirmDelete}
            >
              {deleteBusy ? (
                <Spinner className="h-3 w-3" />
              ) : (
                t("accounts.delete.confirm", { defaultValue: "Remove account" })
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
