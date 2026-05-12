import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

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
          <div className="flex items-center justify-between px-4 py-4">
            <div className="flex flex-col gap-1.5">
              {title && (
                <Button
                  variant="ghost"
                  className={cn(
                    "h-auto px-0 text-sm font-semibold text-left justify-start",
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
                        "mr-1.5 inline-block text-2xs text-muted transition-transform",
                        !collapsed && "rotate-90",
                      )}
                    >
                      ▶
                    </span>
                  )}
                  {title}
                </Button>
              )}
              {description && (
                <span className="text-xs-tight text-muted">{description}</span>
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
