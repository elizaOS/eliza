import type { ReactNode } from "react";

export function WidgetSection({
  title,
  icon,
  action,
  children,
  testId,
  onTitleClick,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId: string;
  /** When set, the title area becomes a button navigating elsewhere. */
  onTitleClick?: () => void;
}) {
  const titleContent = (
    <>
      <span className="inline-flex shrink-0 items-center justify-center text-muted [&>svg]:h-3.5 [&>svg]:w-3.5">
        {icon}
      </span>
      <span className="truncate text-[11px] leading-none font-semibold uppercase tracking-[0.16em] text-muted">
        {title}
      </span>
    </>
  );
  return (
    <section data-testid={testId} className="space-y-1">
      <div className="flex items-center justify-between gap-2 pr-1">
        {onTitleClick ? (
          <button
            type="button"
            onClick={onTitleClick}
            className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] bg-transparent px-0.5 py-1 text-left transition-colors hover:text-txt"
          >
            {titleContent}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-0.5 py-1">
            {titleContent}
          </div>
        )}
        {action}
      </div>
      <div className="px-3 text-xs">{children}</div>
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
          <p className="text-3xs text-muted/70">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
