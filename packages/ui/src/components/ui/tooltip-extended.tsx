import { Z_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";

/**
 * Hover-only tooltip with optional shortcut hint. Used as the icon-button
 * affordance pattern in plugins/app-companion. The other extended-tooltip
 * primitives (HoverTooltip, Spotlight, useGuidedTour, TourStep) were
 * deleted as zero-consumer in the Layer 5b sweep — their last shipping
 * surface was a guided-tour feature that was never wired up.
 */
export function IconTooltip({
  children,
  label,
  shortcut,
  position = "top",
  multiline = false,
}: {
  children: React.ReactNode;
  label: string;
  shortcut?: string;
  position?: "top" | "bottom";
  /** Long labels: wrap and cap width. */
  multiline?: boolean;
}) {
  return (
    <div className="relative isolate group">
      {children}
      <div
        className={cn(
          `absolute px-3 py-2 bg-bg-elevated border border-border text-xs text-txt-strong rounded-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-opacity duration-200 z-[${Z_OVERLAY}] shadow-lg pointer-events-none`,
          position === "top"
            ? "bottom-full left-1/2 -translate-x-1/2 mb-2"
            : "top-full left-1/2 -translate-x-1/2 mt-2",
          multiline
            ? "min-w-[10rem] max-w-[min(22rem,calc(100vw_-_1.5rem))] whitespace-normal text-left leading-snug"
            : "min-w-[6rem] whitespace-nowrap",
        )}
        role="tooltip"
      >
        <div className="font-medium">{label}</div>
        {shortcut && <div className="text-muted mt-0.5">{shortcut}</div>}
        <div
          className={
            position === "top"
              ? "absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-bg-elevated"
              : "absolute bottom-full left-1/2 -translate-x-1/2 -mb-1 border-4 border-transparent border-b-bg-elevated"
          }
        />
      </div>
    </div>
  );
}
