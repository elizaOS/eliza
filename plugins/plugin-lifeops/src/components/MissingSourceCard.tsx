import { useAgentElement } from "@elizaos/ui/agent-surface";
import { PlugZap } from "lucide-react";

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "source"
  );
}

function MissingSourceCta({
  cardTitle,
  ctaLabel,
  onCta,
}: {
  cardTitle: string;
  ctaLabel: string;
  onCta: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `overview-connect-${slugify(cardTitle)}`,
    role: "button",
    label: `${ctaLabel}: ${cardTitle}`,
    group: "lifeops-overview",
    description: `Connect the ${cardTitle} data source`,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onCta}
      aria-label={ctaLabel}
      title={ctaLabel}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/16 bg-bg/40 text-txt transition-colors hover:border-accent/30 hover:text-accent"
      {...agentProps}
    >
      <PlugZap className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{ctaLabel}</span>
    </button>
  );
}

interface MissingSourceCardProps {
  title: string;
  ctaLabel?: string;
  onCta?: () => void;
  className?: string;
}

export function MissingSourceCard({
  title,
  ctaLabel,
  onCta,
  className = "",
}: MissingSourceCardProps) {
  return (
    <section
      data-testid="lifeops-overview-missing-source"
      data-source-title={title}
      className={`flex min-w-0 items-center gap-3 rounded-lg border border-border/16 bg-card/8 px-3 py-2 ${className}`}
    >
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/16 bg-bg/30 text-muted">
        <PlugZap className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
        {title}
      </div>
      {ctaLabel && onCta ? (
        <MissingSourceCta cardTitle={title} ctaLabel={ctaLabel} onCta={onCta} />
      ) : null}
    </section>
  );
}
