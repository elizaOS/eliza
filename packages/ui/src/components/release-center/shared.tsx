/**
 * Small presentational primitives shared across the Release Center sections: a
 * `StatusPill` mapping a neutral/good/warning tone onto the `StatusBadge`
 * variants, and semantic definition-list primitives. `DefinitionList` owns
 * the quiet row separators so metadata is not boxed into nested cards.
 */

import type { ReactNode } from "react";
import { useAppSelector } from "../../state";
import { cn } from "../../utils";
import { StatusBadge, type StatusVariant } from "../ui/status-badge";

const PILL_TONE_MAP: Record<string, StatusVariant> = {
  good: "success",
  warning: "warning",
  neutral: "muted",
};

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "good" | "warning";
}) {
  return (
    <StatusBadge
      label={label}
      variant={PILL_TONE_MAP[tone] ?? "muted"}
      className="rounded-full px-2.5 py-1 text-xs-tight font-medium normal-case"
    />
  );
}

export function DefinitionList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl className={cn("divide-y divide-border/60", className)}>{children}</dl>
  );
}

export function DefinitionRow({
  emptyFallback,
  label,
  value,
}: {
  emptyFallback?: string;
  label: string;
  value: string | number | null | undefined;
}) {
  const t = useAppSelector((s) => s.t);
  return (
    <div className="grid grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)] items-start gap-4 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-xs text-txt">
        {value ??
          emptyFallback ??
          t("common.unavailable", { defaultValue: "Unavailable" })}
      </dd>
    </div>
  );
}
