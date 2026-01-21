"use client";

import { cn } from "@polyagent/shared";
import type { LucideIcon } from "lucide-react";

/**
 * Props for the EmptyState component.
 */
interface EmptyStateProps {
  /** Optional icon to display */
  icon?: LucideIcon;
  /** Title text */
  title: string;
  /** Description text */
  description: string;
  /** Optional action button */
  action?: {
    /** Button label */
    label: string;
    /** Button click handler */
    onClick: () => void;
  };
  /** Additional CSS classes */
  className?: string;
}

/**
 * Empty state component for displaying when there's no content.
 *
 * Shows a centered message with optional icon and action button.
 * Used to indicate empty lists, no results, or initial states.
 *
 * @param props - EmptyState component props
 * @returns Empty state element
 *
 * @example
 * ```tsx
 * <EmptyState
 *   icon={Inbox}
 *   title="No messages"
 *   description="You don't have any messages yet"
 *   action={{ label: "Send Message", onClick: handleSend }}
 * />
 * ```
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-4 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="mb-4 rounded-full bg-muted/50 p-4">
          <Icon size={48} className="text-muted-foreground/70" />
        </div>
      )}
      <h3 className="mb-2 font-semibold text-lg">{title}</h3>
      <p className="mb-6 max-w-sm text-muted-foreground text-sm">
        {description}
      </p>
      {action && (
        <button
          onClick={action.onClick}
          className="rounded-md bg-primary px-6 py-2 font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
