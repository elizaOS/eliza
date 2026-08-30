/**
 * Header building blocks for a page panel: PanelHeader (heading + description +
 * actions row), plus the small trim pieces — MetaPill, PageActionRail,
 * PanelNotice, and SummaryCard — composed by pages via the PagePanel compound.
 */
import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
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
    <Badge
      asChild
      variant={
        tone === "accent"
          ? "metaAccent"
          : tone === "strong"
            ? "metaStrong"
            : "metaDefault"
      }
      size={compact ? "metaCompact" : "meta"}
      className={className}
    >
      <span {...props} />
    </Badge>
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
          ? "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 px-1 py-2"
          : "flex items-start gap-2 px-1 py-2",
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
                "text-2xs font-medium text-muted",
                eyebrowClassName,
              )}
            >
              {eyebrow}
            </div>
          ) : null}
          <div
            className={cn(
              "text-sm font-semibold text-txt-strong",
              eyebrow && "mt-0.5",
              headingClassName,
            )}
          >
            {heading}
          </div>
          {description ? (
            <div className={cn("sr-only", descriptionClassName)}>
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
    <div className={cn("p-2", compact && "p-1.5", className)} {...props} />
  );
}

export function PageActionRail({ className, ...props }: PageActionRailProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
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
  // Tone colors the copy only — never the action rail. Cascading `text-muted`
  // onto buttons made primary CTAs (accent fill) render with unreadable labels.
  const toneClass =
    tone === "accent"
      ? "text-txt"
      : tone === "warning"
        ? "text-txt"
        : tone === "danger"
          ? "text-danger"
          : "text-muted";

  return (
    <div
      className={cn(
        // Dense by default — callers that need air add it explicitly. The old
        // px-1 py-2 read as empty padding inside accordion/setup rows.
        "p-0 text-sm",
        className,
      )}
      {...props}
    >
      {actions ? (
        // Always left copy / right actions (wrap only when the row is too
        // narrow). Avoid sm:-only row which stacked buttons under the copy on
        // mid-width settings panes.
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div
            className={cn("min-w-0 flex-1 basis-[min(100%,16rem)]", toneClass)}
          >
            {children}
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 text-txt-strong">
            {actions}
          </div>
        </div>
      ) : (
        <div className={toneClass}>{children}</div>
      )}
    </div>
  );
}
