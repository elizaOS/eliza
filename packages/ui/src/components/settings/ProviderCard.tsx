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
}

const STATUS_DOT_CLASSES: Record<ProviderStatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  muted: "bg-muted/50",
};

/**
 * Compact provider chip. The AI Model section lists many providers; wrapping
 * pills keep them compact and every chip mounted so the agent surface can
 * address any provider by id.
 */
export function ProviderCard({
  id,
  icon: Icon,
  label,
  status,
  current,
  selected,
  onSelect,
}: ProviderCardProps) {
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
    <Button
      ref={ref}
      variant="ghost"
      aria-current={selected ? "true" : undefined}
      aria-label={`${label}, ${stateLabel}`}
      onClick={() => onSelect(id)}
      title={`${label} · ${stateLabel}`}
      {...agentProps}
      className={cn(
        "min-h-[2.25rem] max-w-full gap-2 rounded-full border px-3 py-1.5 text-left text-sm transition-colors   ",
        selected
          ? "border-accent/50 bg-accent/12 text-accent"
          : current
            ? "border-accent/40 bg-accent/8 text-txt-strong hover:bg-accent/12"
            : "border-border bg-card text-txt hover:bg-surface",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          selected ? "text-accent" : current ? "text-accent" : "text-muted",
        )}
        aria-hidden
      />
      <span className="truncate font-medium">{label}</span>
      {current ? (
        <CheckCircle2
          className="h-3.5 w-3.5 shrink-0 text-accent"
          aria-hidden
        />
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            STATUS_DOT_CLASSES[status.tone],
          )}
          aria-hidden
        />
      )}
    </Button>
  );
}
