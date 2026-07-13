/**
 * UseCaseRouting — the per-use-case fallback chain editor.
 *
 * A use case (Chat, Coding agents) routes through an ORDERED chain of tiers:
 * primary → fallback 1 → fallback 2. The user defines the cross-provider tier
 * order here; the smart reset-time rotation only reorders WITHIN a tier's
 * equals at runtime. Each rung shows a live status dot (available / throttled,
 * resets in Xh / unavailable) so you can see where a request lands right now.
 *
 * Reorder is via up/down controls (no drag dependency — matches the account
 * priority pattern already in the codebase and stays keyboard-accessible).
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AccountRoutingTier,
  AccountUseCaseId,
  ResolvedRoutingTier,
} from "../../api/client-accounts";
import type { AccountsListProvider } from "../../api/client-agent";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { getAccountProviderOption } from "./account-provider-options";
import { ProviderMark } from "./provider-icons";
import { formatResetIn } from "./reset-time";

const USE_CASE_META: Record<AccountUseCaseId, { label: string; hint: string }> =
  {
    chat: {
      label: "Chat",
      hint: "Which accounts answer conversations, in order.",
    },
    codingAgent: {
      label: "Coding agents",
      hint: "Which accounts run task agents, in order.",
    },
  };

function StatusDot({ status }: { status: ResolvedRoutingTier["status"] }) {
  const tone =
    status === "available"
      ? "bg-ok"
      : status === "throttled"
        ? "bg-warn"
        : "bg-muted/40";
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        tone,
        status === "available" && "shadow-[0_0_0_3px] shadow-ok/15",
      )}
      aria-hidden
    />
  );
}

interface TierRowProps {
  tier: ResolvedRoutingTier;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function TierRow({
  tier,
  index,
  isFirst,
  isLast,
  disabled,
  onMoveUp,
  onMoveDown,
  onRemove,
}: TierRowProps) {
  const t = useAppSelector((s) => s.t);
  const option = getAccountProviderOption(tier.providerId);
  const name = option?.name ?? tier.providerId;
  const resetIn = formatResetIn(tier.resetsAt);
  const statusLabel =
    tier.status === "available"
      ? t("accounts.routing.available", { defaultValue: "Available" })
      : tier.status === "throttled"
        ? resetIn
          ? t("accounts.routing.throttledReset", {
              defaultValue: `Throttled · resets in ${resetIn}`,
              resetIn,
            })
          : t("accounts.routing.throttled", { defaultValue: "Throttled" })
        : t("accounts.routing.unavailable", {
            defaultValue: "Not connected",
          });

  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border/45 bg-card/40 px-2.5 py-2">
      <span className="w-5 shrink-0 text-center text-[11px] font-medium tabular-nums text-muted">
        {index === 0
          ? t("accounts.routing.primaryShort", { defaultValue: "1" })
          : index + 1}
      </span>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/50 bg-bg-accent text-txt-strong">
        <ProviderMark
          providerId={tier.providerId}
          className="h-3.5 w-3.5"
          title={name}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-txt-strong">
          {name}
          {index === 0 ? (
            <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-accent-muted">
              {t("accounts.routing.primary", { defaultValue: "primary" })}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <StatusDot status={tier.status} />
          {statusLabel}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          disabled={isFirst || disabled}
          onClick={onMoveUp}
          aria-label={t("accounts.routing.moveUp", {
            defaultValue: "Move earlier in chain",
          })}
        >
          <ArrowUp className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          disabled={isLast || disabled}
          onClick={onMoveDown}
          aria-label={t("accounts.routing.moveDown", {
            defaultValue: "Move later in chain",
          })}
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted hover:text-destructive"
          disabled={disabled}
          onClick={onRemove}
          aria-label={t("accounts.routing.remove", {
            defaultValue: "Remove from chain",
          })}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

interface UseCaseRoutingProps {
  useCase: AccountUseCaseId;
  tiers: ResolvedRoutingTier[];
  /** Providers eligible for this use case, to populate the add picker. */
  eligibleProviders: LinkedAccountProviderId[];
  providers: AccountsListProvider[];
  saving: boolean;
  onChange: (tiers: AccountRoutingTier[]) => void;
}

export function UseCaseRouting({
  useCase,
  tiers,
  eligibleProviders,
  saving,
  onChange,
}: UseCaseRoutingProps) {
  const t = useAppSelector((s) => s.t);
  const [adding, setAdding] = useState(false);
  const meta = USE_CASE_META[useCase];

  const used = useMemo(
    () => new Set(tiers.map((tier) => tier.providerId)),
    [tiers],
  );
  const addable = useMemo(
    () => eligibleProviders.filter((id) => !used.has(id)),
    [eligibleProviders, used],
  );

  const bare = (list: ResolvedRoutingTier[]): AccountRoutingTier[] =>
    list.map((tier) => ({
      providerId: tier.providerId,
      ...(tier.accountId ? { accountId: tier.accountId } : {}),
    }));

  const move = (index: number, direction: "up" | "down") => {
    const next = [...tiers];
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= next.length) return;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    onChange(bare(next));
  };

  const remove = (index: number) => {
    onChange(bare(tiers.filter((_, i) => i !== index)));
  };

  const add = (providerId: LinkedAccountProviderId) => {
    onChange([...bare(tiers), { providerId }]);
    setAdding(false);
  };

  return (
    <section className="grid gap-2 rounded-lg border border-border/45 bg-card/25 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-txt-strong">
            {t(`accounts.routing.useCase.${useCase}`, {
              defaultValue: meta.label,
            })}
          </h4>
          <p className="mt-0.5 text-[11px] leading-4 text-muted">
            {t(`accounts.routing.useCaseHint.${useCase}`, {
              defaultValue: meta.hint,
            })}
          </p>
        </div>
      </div>

      {tiers.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/45 bg-bg-accent/20 px-3 py-2.5 text-[11px] text-muted">
          {t("accounts.routing.empty", {
            defaultValue:
              "No explicit chain — requests use the default eligibility order. Add a provider to pin the fallback order.",
          })}
        </p>
      ) : (
        <div className="grid gap-1.5">
          {tiers.map((tier, index) => (
            <TierRow
              key={`${tier.providerId}:${tier.accountId ?? "any"}`}
              tier={tier}
              index={index}
              isFirst={index === 0}
              isLast={index === tiers.length - 1}
              disabled={saving}
              onMoveUp={() => move(index, "up")}
              onMoveDown={() => move(index, "down")}
              onRemove={() => remove(index)}
            />
          ))}
        </div>
      )}

      {adding && addable.length > 0 ? (
        <Select
          onValueChange={(value) => add(value as LinkedAccountProviderId)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue
              placeholder={t("accounts.routing.pickProvider", {
                defaultValue: "Pick a provider to add",
              })}
            />
          </SelectTrigger>
          <SelectContent>
            {addable.map((id) => {
              const option = getAccountProviderOption(id);
              return (
                <SelectItem key={id} value={id} className="text-xs">
                  {option?.name ?? id}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-fit gap-1.5 px-2 text-[11px] text-muted hover:text-txt-strong"
          disabled={saving || addable.length === 0}
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {addable.length === 0
            ? t("accounts.routing.allAdded", {
                defaultValue: "All eligible providers added",
              })
            : t("accounts.routing.addTier", {
                defaultValue: "Add fallback provider",
              })}
        </Button>
      )}
    </section>
  );
}
