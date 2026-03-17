import * as React from "react";
import { cn } from "../../lib/utils";

/* ── SectionCard ─────────────────────────────────────────────────────── */

export interface SectionCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Section title shown in the header */
  title?: string;
  /** Optional description below the title */
  description?: string;
  /** Optional actions (buttons, badges) aligned to the right of the header */
  actions?: React.ReactNode;
  /** Whether the section is collapsible */
  collapsible?: boolean;
  /** Default collapsed state (only when collapsible) */
  defaultCollapsed?: boolean;
}

export const SectionCard = React.forwardRef<HTMLDivElement, SectionCardProps>(
  (
    {
      title,
      description,
      actions,
      collapsible = false,
      defaultCollapsed = false,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

    return (
      <div
        ref={ref}
        className={cn("border border-border bg-card text-card-fg", className)}
        {...props}
      >
        {(title || actions) && (
          <div className="flex items-center justify-between border-b border-border px-4 py-4">
            <div className="flex flex-col gap-1.5">
              {title && (
                <button
                  type="button"
                  className={cn(
                    "text-sm font-semibold text-left",
                    collapsible &&
                      "cursor-pointer hover:text-accent transition-colors",
                    !collapsible && "cursor-default",
                  )}
                  onClick={
                    collapsible ? () => setCollapsed((c) => !c) : undefined
                  }
                  tabIndex={collapsible ? 0 : -1}
                >
                  {collapsible && (
                    <span
                      className={cn(
                        "mr-1.5 inline-block text-[10px] text-muted transition-transform",
                        !collapsed && "rotate-90",
                      )}
                    >
                      ▶
                    </span>
                  )}
                  {title}
                </button>
              )}
              {description && (
                <span className="text-[11px] text-muted">{description}</span>
              )}
            </div>
            {actions && (
              <div className="flex items-center gap-2">{actions}</div>
            )}
          </div>
        )}
        {(!collapsible || !collapsed) && <div className="p-4">{children}</div>}
      </div>
    );
  },
);
SectionCard.displayName = "SectionCard";
