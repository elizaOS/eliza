import { ArrowRight, PlugZap } from "lucide-react";

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
        <button
          type="button"
          onClick={onCta}
          aria-label={ctaLabel}
          title={ctaLabel}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border/16 bg-bg/40 px-3 text-xs font-medium text-txt transition-colors hover:border-accent/30 hover:text-accent"
        >
          <span>{ctaLabel}</span>
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}
