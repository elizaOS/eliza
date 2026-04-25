import { ArrowRight, PlugZap } from "lucide-react";

interface MissingSourceCardProps {
  title: string;
  reason: string;
  ctaLabel?: string;
  onCta?: () => void;
  className?: string;
}

export function MissingSourceCard({
  title,
  reason,
  ctaLabel,
  onCta,
  className = "",
}: MissingSourceCardProps) {
  return (
    <section
      data-testid="lifeops-overview-missing-source"
      data-source-title={title}
      className={`flex min-w-0 items-start gap-3 rounded-lg border border-border/16 bg-card/8 px-4 py-3 ${className}`}
    >
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/16 bg-bg/30 text-muted">
        <PlugZap className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-txt">{title}</div>
        <p className="mt-1 text-xs leading-relaxed text-muted">{reason}</p>
      </div>
      {ctaLabel && onCta ? (
        <button
          type="button"
          onClick={onCta}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border/16 bg-bg/40 px-3 text-xs font-medium text-txt transition-colors hover:border-accent/30 hover:text-accent"
        >
          {ctaLabel}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}
