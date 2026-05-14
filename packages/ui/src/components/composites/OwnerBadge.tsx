/**
 * OwnerBadge — small Crown indicator (R10 §4.2).
 *
 * Shared component for the three surfaces that need to show OWNER role:
 * 1. Shell `Header` — next to the user's display name.
 * 2. Chat avatar overlay — corner sticker on the owner's message bubbles.
 * 3. Onboarding step 6 — confirmation card.
 *
 * Keeps the Crown rendering + tooltip + sizing identical everywhere so the
 * three surfaces don't drift apart. The existing relationships graph uses
 * the same `<Crown/>` lucide icon directly; we keep that one as is (it's a
 * tight one-off layout) and centralise the more reusable case here.
 *
 * The component renders nothing when `isOwner` is false — callers can
 * use it inline without a wrapping conditional.
 */

// biome-ignore lint/correctness/noUnusedImports: required for JSX transform.
import * as React from "react";
import { Crown } from "lucide-react";

import { cn } from "../../lib/utils";

export type OwnerBadgeVariant = "inline" | "overlay" | "card";
export type OwnerBadgeSize = "xs" | "sm" | "md";

export interface OwnerBadgeProps {
  /** Whether to render. Renders nothing when false (no wrapper, no DOM). */
  isOwner?: boolean;
  /** Visual placement preset. */
  variant?: OwnerBadgeVariant;
  /** Crown icon size. */
  size?: OwnerBadgeSize;
  /** Override the default tooltip (default: "OWNER — full control"). */
  tooltip?: string;
  /** Force a specific accent override class. */
  className?: string;
  "data-testid"?: string;
}

const SIZE_CLASS: Record<OwnerBadgeSize, string> = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
};

const VARIANT_CLASS: Record<OwnerBadgeVariant, string> = {
  inline: "inline-flex items-center align-baseline",
  overlay:
    "absolute -right-0.5 -top-0.5 inline-flex items-center justify-center rounded-full bg-bg/90 p-0.5 shadow",
  card: "inline-flex items-center justify-center rounded-md bg-accent/15 px-2 py-1",
};

export function OwnerBadge({
  isOwner = true,
  variant = "inline",
  size = "sm",
  tooltip = "OWNER — full control",
  className,
  "data-testid": dataTestId,
}: OwnerBadgeProps): React.ReactElement | null {
  if (!isOwner) return null;

  return (
    <span
      data-testid={dataTestId ?? "owner-badge"}
      data-variant={variant}
      data-size={size}
      className={cn(VARIANT_CLASS[variant], className)}
      title={tooltip}
      aria-label={tooltip}
      role="img"
    >
      <Crown className={cn(SIZE_CLASS[size], "text-accent")} aria-hidden />
    </span>
  );
}

export default OwnerBadge;
