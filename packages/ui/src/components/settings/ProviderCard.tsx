/**
 * Selectable provider control used by ProviderSwitcher, in two shapes: the
 * compact `pill` chip for long provider lists, and the full-width `tile` row
 * (icon + label + one-line description + status) for the few top-level
 * choices — Cloud vs Local — where each option earns an explanation. `current`
 * is the provider serving inference (orange + Active). `selected` is only
 * which panel is open; it must not reuse the serving chrome. Agent-addressable
 * via `useAgentElement`; selection is fully controlled by the parent.
 */

import { CheckCircle2 } from "lucide-react";
import type { ComponentType } from "react";
import { useAgentElement } from "../../agent-surface";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type ProviderStatusTone = "ok" | "warn" | "muted";
export type ProviderCategory = "cloud" | "subscription" | "key" | "local";

export interface ProviderStatus {
  tone: ProviderStatusTone;
  label: string;
}

export interface ProviderCardProps {
  id: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  category: ProviderCategory;
  status: ProviderStatus;
  current: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  /** One-line explanation; rendered only by the `tile` variant. */
  description?: string;
  /** `pill` (default) — compact chip; `tile` — full-width descriptive row. */
  variant?: "pill" | "tile";
}

const STATUS_DOT_CLASSES: Record<ProviderStatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  muted: "bg-muted/50",
};

export function ProviderCard({
  id,
  icon: Icon,
  label,
  status,
  current,
  selected,
  onSelect,
  description,
  variant = "pill",
}: ProviderCardProps) {
  const stateLabel = current ? "Active" : status.label;
  const presentation = current ? "current" : selected ? "selected" : "idle";
  const iconChrome = current
    ? "text-accent"
    : selected
      ? "text-txt"
      : "text-muted";

  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `provider-${id}`,
    role: "card",
    label,
    group: "provider-cards",
    status: current ? "current" : selected ? "selected" : undefined,
    onActivate: () => onSelect(id),
  });

  if (variant === "tile") {
    return (
      <Button
        ref={ref}
        variant={current ? "surfaceAccent" : selected ? "outline" : "choice"}
        size="card"
        align="start"
        aria-current={current ? "true" : undefined}
        aria-pressed={selected}
        data-provider-presentation={presentation}
        aria-label={`${label}, ${stateLabel}`}
        onClick={() => onSelect(id)}
        title={`${label} · ${stateLabel}`}
        {...agentProps}
        className="w-full"
      >
        <Icon
          className={cn("mt-0.5 size-5 shrink-0", iconChrome)}
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-txt-strong">
              {label}
            </span>
            {current ? (
              <span className="flex shrink-0 items-center gap-1 text-xs text-accent">
                <CheckCircle2 className="size-3.5" aria-hidden />
                Active
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    STATUS_DOT_CLASSES[status.tone],
                  )}
                  aria-hidden
                />
                {status.label}
              </span>
            )}
          </span>
          {description ? (
            <span className="whitespace-normal text-xs leading-snug text-muted">
              {description}
            </span>
          ) : null}
        </span>
      </Button>
    );
  }

  return (
    <Button
      ref={ref}
      variant={current ? "surfaceAccent" : selected ? "outline" : "choice"}
      size="pillDense"
      aria-current={current ? "true" : undefined}
      aria-pressed={selected}
      data-provider-presentation={presentation}
      aria-label={`${label}, ${stateLabel}`}
      onClick={() => onSelect(id)}
      title={`${label} · ${stateLabel}`}
      {...agentProps}
      className="max-w-full"
    >
      <Icon className={cn("size-4 shrink-0", iconChrome)} aria-hidden />
      <span className="truncate font-medium">{label}</span>
      {current ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-accent" aria-hidden />
      ) : (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            STATUS_DOT_CLASSES[status.tone],
          )}
          aria-hidden
        />
      )}
    </Button>
  );
}
