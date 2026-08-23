/**
 * Renders edge paging controls for launcher and carousel surfaces without
 * owning their page state.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import type * as React from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * Web/desktop `<` `>` edge buttons for a horizontal pager (#10717). Rendered
 * ONLY on desktop-width, fine-pointer / hover-capable devices, so they never
 * appear in the compact mobile layout or on touch/coarse phones and tablets.
 * Compact layouts keep the swipe gesture as their sole navigation even when a
 * mouse happens to be attached or browser device emulation reports a fine
 * pointer.
 *
 * Icon-only (no card chrome), neutral resting → neutral hover (no orange→black,
 * no blue), positioned on the vertical center of the left/right edges. Each
 * arrow is hidden when there is no page to move to in that direction.
 */
/**
 * Devices that get the resting `<` `>` affordance. FirstSessionSwipeHint keys
 * off the exact same query (inverted) so the two teaching surfaces are perfect
 * complements — every device gets exactly one of them, never both.
 */
export const FINE_POINTER_EDGE_BUTTON_QUERY =
  "(min-width: 768px) and (hover: hover) and (pointer: fine)";

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
  const finePointer = useMediaQuery(FINE_POINTER_EDGE_BUTTON_QUERY);
  if (!finePointer) return null;

  const prefix = idPrefix ? `${idPrefix}-` : "";
  const edgeClass =
    "absolute top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center text-white/55 transition-colors hover:text-white";

  return (
    <>
      {canPrev ? (
        <Button
          unstyled
          variant="ghost"
          size="icon"
          data-testid={`${prefix}pager-edge-prev`}
          aria-label={prevLabel}
          onClick={goPrev}
          className={cn(edgeClass, "left-1 hover:bg-transparent")}
        >
          <ChevronLeft className="size-6" aria-hidden />
        </Button>
      ) : null}
      {canNext ? (
        <Button
          unstyled
          variant="ghost"
          size="icon"
          data-testid={`${prefix}pager-edge-next`}
          aria-label={nextLabel}
          onClick={goNext}
          className={cn(edgeClass, "right-1 hover:bg-transparent")}
        >
          <ChevronRight className="size-6" aria-hidden />
        </Button>
      ) : null}
    </>
  );
}
