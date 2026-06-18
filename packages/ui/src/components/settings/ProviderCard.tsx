import {
  AlertCircle,
  CheckCircle2,
  Circle,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { useAgentElement } from "../../agent-surface";

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
}

const CATEGORY_CHIP_CLASSES: Record<ProviderCategory, string> = {
  cloud: "border-accent/30 bg-accent/10 text-accent",
  subscription: "border-border bg-surface text-txt",
  key: "border-border bg-surface text-muted",
  local: "border-ok/30 bg-ok/10 text-ok",
};

const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  cloud: "Cloud",
  subscription: "Subscription",
  key: "API key",
  local: "Local",
};

const STATUS_ICON_CLASSES: Record<ProviderStatusTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  muted: "text-muted",
};

const STATUS_ICON: Record<ProviderStatusTone, LucideIcon> = {
  ok: CheckCircle2,
  warn: AlertCircle,
  muted: Circle,
};

export function ProviderCard({
  id,
  icon: Icon,
  label,
  category,
  status,
  current,
  selected,
  onSelect,
}: ProviderCardProps) {
  const StatusIcon = current ? CheckCircle2 : STATUS_ICON[status.tone];
  const iconClass = current ? "text-accent" : STATUS_ICON_CLASSES[status.tone];
  const stateLabel = current ? "Active" : status.label;

  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `provider-${id}`,
    role: "card",
    label,
    group: "provider-cards",
    status: selected ? "selected" : current ? "current" : undefined,
    onActivate: () => onSelect(id),
  });

  return (
    <button
      ref={ref}
      type="button"
      aria-current={selected ? "true" : undefined}
      aria-label={`${label}, ${stateLabel}`}
      onClick={() => onSelect(id)}
      title={`${label} · ${stateLabel}`}
      {...agentProps}
      className={`flex min-h-[3.25rem] w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
        selected
          ? "border-accent/45 bg-accent/10 hover:bg-accent/12"
          : "border-border bg-card hover:bg-surface"
      }`}
    >
      <span
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md ring-1 ${
          current
            ? "bg-accent/10 text-accent ring-accent/20"
            : "bg-surface text-txt-strong ring-border/70"
        }`}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium leading-5 text-txt-strong">
          {label}
        </span>
        <span className="truncate text-xs leading-relaxed text-muted">
          {stateLabel}
        </span>
      </span>
      <span
        className={`hidden shrink-0 rounded-full border px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider sm:inline-flex ${CATEGORY_CHIP_CLASSES[category]}`}
        aria-hidden
      >
        {CATEGORY_LABEL[category]}
      </span>
      <span
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${iconClass}`}
        title={stateLabel}
        aria-hidden
      >
        <StatusIcon className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}
