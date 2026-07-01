import { ChevronLeft, ChevronRight } from "lucide-react";
import type * as React from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";

/**
 * Web/desktop `<` `>` edge buttons for a horizontal pager (#10717). Rendered
 * ONLY on desktop-width fine-pointer / hover-capable devices, so they never
 * appear on touch/coarse phones/tablets where the swipe gesture is the sole
 * navigation. The width guard also keeps mobile audit captures clean when a
 * headless browser reports a fine pointer at phone dimensions.
 *
 * Icon-only (no card chrome), neutral resting → neutral hover (no orange→black,
 * no blue), positioned on the vertical center of the left/right edges. Each
 * arrow is hidden when there is no page to move to in that direction.
 */
const DESKTOP_EDGE_BUTTON_QUERY =
  "(hover: hover) and (pointer: fine) and (min-width: 1024px)";

export function PagerEdgeButtons({
  canPrev,
  canNext,
  goPrev,
  goNext,
  prevLabel = "Previous view",
  nextLabel = "Next view",
  idPrefix,
}: {
  canPrev: boolean;
  canNext: boolean;
  goPrev: () => void;
  goNext: () => void;
  prevLabel?: string;
  nextLabel?: string;
  /**
   * Disambiguates the `data-testid`s when more than one pager is mounted at
   * once (the home↔launcher rail wraps the inner app-page pager). e.g.
   * `idPrefix="rail"` → `rail-pager-edge-prev`. Omit for the default ids.
   */
  idPrefix?: string;
}): React.JSX.Element | null {
  const desktopFinePointer = useMediaQuery(DESKTOP_EDGE_BUTTON_QUERY);
  if (!desktopFinePointer) return null;

  const prefix = idPrefix ? `${idPrefix}-` : "";
  const edgeClass =
    "absolute top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center text-white/55 transition-colors hover:text-white";

  return (
    <>
      {canPrev ? (
        <button
          type="button"
          data-testid={`${prefix}pager-edge-prev`}
          aria-label={prevLabel}
          onClick={goPrev}
          className={cn(edgeClass, "left-1")}
        >
          <ChevronLeft className="h-6 w-6" aria-hidden />
        </button>
      ) : null}
      {canNext ? (
        <button
          type="button"
          data-testid={`${prefix}pager-edge-next`}
          aria-label={nextLabel}
          onClick={goNext}
          className={cn(edgeClass, "right-1")}
        >
          <ChevronRight className="h-6 w-6" aria-hidden />
        </button>
      ) : null}
    </>
  );
}
