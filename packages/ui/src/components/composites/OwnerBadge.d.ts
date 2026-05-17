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
import type * as React from "react";
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
export declare function OwnerBadge({
  isOwner,
  variant,
  size,
  tooltip,
  className,
  "data-testid": dataTestId,
}: OwnerBadgeProps): React.ReactElement | null;
export default OwnerBadge;
//# sourceMappingURL=OwnerBadge.d.ts.map
