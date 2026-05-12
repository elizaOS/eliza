import {
  AlertCircle,
  CheckCircle2,
  Circle,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

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
  subscription: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  key: "border-border bg-bg/60 text-muted",
  local: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
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

  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      aria-label={`${label}, ${stateLabel}`}
      onClick={() => onSelect(id)}
      title={`${label} · ${stateLabel}`}
      className={`flex h-11 w-full items-center gap-2 rounded-lg border px-2 text-left transition-colors ${
        selected
          ? "border-accent/45 bg-accent/10"
          : "border-border/45 bg-card/35 hover:border-border hover:bg-card/70"
      }`}
    >
      <span
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
          current ? "bg-accent/10 text-accent" : "bg-bg/60 text-muted"
        }`}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-txt">
        {label}
      </span>
      <span
        className={`hidden shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider sm:inline-flex ${CATEGORY_CHIP_CLASSES[category]}`}
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
