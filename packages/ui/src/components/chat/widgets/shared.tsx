/**
 * Shared layout primitives for chat-sidebar widgets: `WidgetSection` (labelled
 * section with an icon, optional navigating title, and trailing action) and
 * `EmptyWidgetState` (centered empty placeholder). Every sidebar widget renders
 * through these so the rail stays visually consistent.
 */
import type { ReactNode } from "react";
import { Button } from "../../ui/button";

type WidgetSectionTone = "default" | "home";

export function WidgetSection({
  title,
  icon,
  action,
  children,
  testId,
  onTitleClick,
  tone = "default",
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId: string;
  /** When set, the title area becomes a button navigating elsewhere. */
  onTitleClick?: () => void;
  /**
   * Home widgets sit directly on the ember field: bare white-family text with
   * no card chrome, per the sparse-home doctrine — the wallpaper is the
   * surface, so the section adds only readable foregrounds.
   */
  tone?: WidgetSectionTone;
}) {
  const isHome = tone === "home";
  const titleContent = (
    <>
      <span
        className={`inline-flex shrink-0 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5 ${
          isHome ? "text-white/70" : "text-muted"
        }`}
      >
        {icon}
      </span>
      <span
        className={`truncate text-xs-tight leading-none font-semibold ${
          isHome ? "text-white/75" : "text-muted"
        }`}
      >
        {title}
      </span>
    </>
  );
  return (
    <section
      data-testid={testId}
      className={isHome ? "space-y-2 text-white" : "space-y-0.5"}
    >
      <div className="flex items-center justify-between gap-2 pr-1">
        {onTitleClick ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onTitleClick}
            className={`h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-sm bg-transparent px-0.5 py-1 text-left transition-colors hover:bg-transparent ${
              isHome ? "text-white/75 hover:text-white" : "hover:text-txt"
            }`}
          >
            {titleContent}
          </Button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-0.5 py-1">
            {titleContent}
          </div>
        )}
        {action}
      </div>
      <div className={isHome ? "text-xs" : "px-3 text-xs"}>{children}</div>
    </section>
  );
}

export function EmptyWidgetState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center justify-center gap-2 py-5 text-center">
        <span className="text-muted/50">{icon}</span>
        <p className="text-2xs text-muted">{title}</p>
        {description ? (
          <p className="text-3xs text-muted">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
