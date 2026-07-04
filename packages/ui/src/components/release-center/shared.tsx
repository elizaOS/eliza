/**
 * Small presentational primitives shared across the Release Center sections: a
 * `StatusPill` mapping a neutral/good/warning tone onto the `StatusBadge`
 * variants, and a `DefinitionRow` (label + value with an "Unavailable"
 * fallback).
 */

import { useAppSelector } from "../../state";
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
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-right text-xs text-txt break-all">
        {value ??
          emptyFallback ??
          t("common.unavailable", { defaultValue: "Unavailable" })}
      </div>
    </div>
  );
}
