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
        "inline-flex min-h-6 items-center rounded-sm px-2.5 py-1 text-xs-tight shadow-xs",
        tone === "accent"
          ? "border border-accent/55 bg-accent-subtle font-bold text-txt-strong"
          : tone === "strong"
            ? "border border-border bg-card font-medium text-txt-strong"
            : "border border-border bg-card font-medium text-muted",
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
        "rounded-sm border border-border bg-card p-4 shadow-xs",
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
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-border bg-card shadow-xs",
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
        "rounded-sm border px-4 py-3 text-sm",
        tone === "accent"
          ? "border-accent bg-accent-subtle text-txt"
          : tone === "warning"
            ? "border-warn/30 bg-warn/10 text-txt"
            : tone === "danger"
              ? "border-danger/30 bg-danger/10 text-danger"
              : "border-border bg-card text-muted",
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
