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
 * ONLY on fine-pointer / hover-capable devices, so they never appear on
 * touch/coarse phones/tablets where the swipe gesture is the sole navigation.
 * There is deliberately NO width gate: page dots are off in production, so a
 * fine-pointer window below desktop width (a narrow browser window, a small
 * desktop shell) still needs a visible paging control alongside the drag
 * gesture.
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
  "(hover: hover) and (pointer: fine)";

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
    "absolute top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center text-white/55 transition-colors hover:text-white";

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
          <ChevronLeft className="h-6 w-6" aria-hidden />
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
          <ChevronRight className="h-6 w-6" aria-hidden />
        </Button>
      ) : null}
    </>
  );
}
