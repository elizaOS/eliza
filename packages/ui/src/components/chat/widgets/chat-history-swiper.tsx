/**
 * ChatHistorySwiper — a horizontal, scrollable strip of past-conversation
 * cards with a reset control and an "Undo clear" banner. Presentational only:
 * the active card and the cleared card are supplied by the caller, and every
 * interaction (select / reset / undo) is reported via callbacks. The strip
 * does no fetching, sorting, or history math.
 */

import { RotateCcw, Undo2 } from "lucide-react";
import { Button } from "../../ui/button";

export type HistoryCard = {
  id: string;
  title: string;
  subtitle?: string;
  timestamp?: string;
};

export type ChatHistorySwiperProps = {
  items: HistoryCard[];
  activeIndex?: number;
  onSelect?: (index: number) => void;
  onReset?: () => void;
  /** When set, an undo banner is shown for the most recently cleared card. */
  clearedItem?: HistoryCard | null;
  onUndoClear?: () => void;
};

export function ChatHistorySwiper({
  items,
  activeIndex,
  onSelect,
  onReset,
  clearedItem,
  onUndoClear,
}: ChatHistorySwiperProps) {
  return (
    <div data-testid="chat-history-swiper" className="my-2 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 pr-0.5">
        <span className="text-3xs font-semibold uppercase tracking-[0.16em] text-muted">
          History
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="chat-history-reset"
          aria-label="Reset history"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => onReset?.()}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset
        </Button>
      </div>

      {clearedItem ? (
        <div
          data-testid="chat-history-undo-banner"
          className="flex items-center justify-between gap-2 border border-border bg-card px-3 py-2 text-xs"
          role="status"
        >
          <span className="min-w-0 flex-1 truncate text-muted">
            Cleared “{clearedItem.title}”
          </span>
          <Button
            type="button"
            variant="surfaceAccent"
            size="sm"
            data-testid="chat-history-undo"
            aria-label="Undo clear"
            className="h-7 gap-1.5 px-3 text-xs"
            onClick={() => onUndoClear?.()}
          >
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
            Undo clear
          </Button>
        </div>
      ) : null}

      <div
        className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1"
        role="listbox"
        aria-label="Conversation history"
      >
        {items.map((item, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={isActive}
              data-testid={`chat-history-card-${item.id}`}
              className={`flex w-44 shrink-0 snap-start flex-col gap-1 border bg-card p-3 text-left transition-colors ${
                isActive ? "border-accent" : "border-border hover:bg-surface"
              }`}
              onClick={() => onSelect?.(index)}
            >
              <span className="truncate text-sm font-semibold">
                {item.title}
              </span>
              {item.subtitle ? (
                <span className="truncate text-xs text-muted">
                  {item.subtitle}
                </span>
              ) : null}
              {item.timestamp ? (
                <span className="text-3xs uppercase tracking-wider text-muted/70">
                  {item.timestamp}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
