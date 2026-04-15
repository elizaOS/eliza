import { cn } from "../../../lib/utils";
import type {
  MetaPillProps,
  PageActionRailProps,
  PanelHeaderProps,
  PanelNoticeProps,
  SummaryCardProps,
} from "./page-panel-types";

export function MetaPill({
  className,
  compact = false,
  tone = "default",
  ...props
}: MetaPillProps) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center rounded-full px-2.5 py-1 text-xs-tight shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_18px_-18px_rgba(15,23,42,0.12)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_12px_18px_-18px_rgba(0,0,0,0.24)]",
        tone === "accent"
          ? "border border-accent/55 bg-accent/16 font-bold text-txt-strong shadow-sm"
          : tone === "strong"
            ? "border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_92%,transparent))] font-medium text-txt-strong"
            : "border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_92%,transparent))] font-medium text-muted",
        compact && "min-h-0 px-2 py-1 text-2xs",
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  actions,
  bordered = true,
  className,
  contentClassName,
  description,
  descriptionClassName,
  eyebrow,
  eyebrowClassName,
  heading,
  headingClassName,
  media,
  ...props
}: PanelHeaderProps) {
  const hasActions = Boolean(actions);

  return (
    <div
      className={cn(
        hasActions
          ? "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 sm:px-5"
          : "flex items-start gap-3 px-4 py-3 sm:px-5",
        bordered && "",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {media ? <div className="shrink-0">{media}</div> : null}
        <div className={cn("min-w-0", contentClassName)}>
          {eyebrow ? (
            <div
              className={cn(
                "text-2xs font-semibold uppercase tracking-[0.16em] text-muted/60",
                eyebrowClassName,
              )}
            >
              {eyebrow}
            </div>
          ) : null}
          <div
            className={cn(
              "text-sm font-semibold text-txt-strong",
              eyebrow && "mt-1",
              headingClassName,
            )}
          >
            {heading}
          </div>
          {description ? (
            <div
              className={cn(
                "mt-1 text-xs leading-relaxed text-muted",
                descriptionClassName,
              )}
            >
              {description}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="inline-flex shrink-0 items-start justify-end gap-2 self-start justify-self-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function SummaryCard({
  className,
  compact = false,
  ...props
}: SummaryCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_86%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_18px_26px_-24px_rgba(15,23,42,0.12)] ring-1 ring-border/8 backdrop-blur-sm dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_28px_-24px_rgba(0,0,0,0.28)]",
        compact && "p-3.5",
        className,
      )}
      {...props}
    />
  );
}

export function PageActionRail({ className, ...props }: PageActionRailProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap border border-border/24 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_16px_22px_-18px_rgba(15,23,42,0.14)] backdrop-blur-sm dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_18px_24px_-18px_rgba(0,0,0,0.24)]",
        className,
      )}
      {...props}
    />
  );
}

export function PanelNotice({
  actions,
  className,
  children,
  tone = "default",
  ...props
}: PanelNoticeProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3 text-sm",
        tone === "accent"
          ? "border-accent bg-accent-subtle text-txt"
          : tone === "warning"
            ? "border-warn/30 bg-warn/10 text-txt"
            : tone === "danger"
              ? "border-danger/30 bg-danger/10 text-danger"
              : "border-border/40 bg-card/30 text-muted",
        className,
      )}
      {...props}
    >
      {actions ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>{children}</div>
          <div className="shrink-0">{actions}</div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
