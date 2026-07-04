/**
 * One conversation row in the chat sidebar: title (truncated with tooltip when
 * clipped), rename/delete actions, and active-state styling. On touch devices
 * the row's action menu opens via press-and-hold; click suppression keeps a
 * completed long-press from also firing the row's select handler.
 */
import { MoreHorizontal, PencilLine, X } from "lucide-react";
import type React from "react";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useClickSuppression, usePressAndHold } from "../../../gestures";
import { cn } from "../../../lib/utils";

// z-[200] mirrors Z_OVERLAY in ../../../lib/floating-layers.ts.
// Tailwind v4 cannot detect classes built from runtime template literals,
// so the value is kept inline so the scanner emits the utility.
import { Button } from "../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type {
  ChatConversationLabels,
  ChatConversationSummary,
  ChatVariant,
} from "./chat-types";

function TruncatingConversationTitle({
  displayTitle,
  isActive,
  variant,
}: {
  displayTitle: string;
  isActive: boolean;
  variant: ChatVariant;
}) {
  const titleRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const measure = useCallback(() => {
    const el = titleRef.current;
    if (!el) return;
    setIsTruncated(el.scrollWidth > el.clientWidth + 1);
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = titleRef.current;
    if (!el) return;

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        measure();
      });
      ro.observe(el);
    }

    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const span = (
    <span
      ref={titleRef}
      className={
        variant === "game-modal"
          ? `block w-full min-w-0 max-w-full truncate text-left text-sm font-medium leading-tight transition-colors ${
              isActive
                ? "text-txt text-shadow-glow"
                : "text-white/90 group-hover:text-white"
            }`
          : `block min-w-0 max-w-full flex-1 truncate text-left text-sm font-normal leading-snug transition-colors ${
              isActive
                ? "text-txt"
                : "text-[color:color-mix(in_srgb,var(--text-strong)_80%,var(--text)_20%)] group-hover:text-txt"
            }`
      }
      {...(isTruncated ? { title: displayTitle } : {})}
    >
      {displayTitle}
    </span>
  );

  if (!isTruncated) {
    return span;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{span}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={12}
        className="z-[200] max-w-[min(90vw,22rem)] whitespace-normal break-words px-3 py-2 text-sm leading-snug"
      >
        {displayTitle}
      </TooltipContent>
    </Tooltip>
  );
}

export interface ChatConversationItemProps {
  conversation: ChatConversationSummary;
  deleting?: boolean;
  displayTitle?: string;
  isActive: boolean;
  isConfirmingDelete?: boolean;
  isUnread?: boolean;
  labels?: ChatConversationLabels;
  mobile?: boolean;
  onCancelDelete?: () => void;
  onConfirmDelete?: () => void | Promise<void>;
  onOpenActions?: (
    event:
      | React.MouseEvent<HTMLButtonElement | HTMLDivElement>
      | React.TouchEvent<HTMLButtonElement | HTMLDivElement>,
    conversation: ChatConversationSummary,
  ) => void;
  onRequestDeleteConfirm?: () => void;
  onRequestRename?: () => void;
  onSelect: () => void;
  variant?: ChatVariant;
}

export const ChatConversationItem = memo(function ChatConversationItem({
  conversation,
  deleting = false,
  displayTitle,
  isActive,
  isConfirmingDelete = false,
  isUnread = false,
  labels = {},
  mobile = false,
  onCancelDelete,
  onConfirmDelete,
  onOpenActions,
  onRequestDeleteConfirm,
  onRequestRename,
  onSelect,
  variant = "default",
}: ChatConversationItemProps) {
  // No auto-disarm: the tap the browser synthesizes after a long-press can land a
  // full task later, so the arm must persist until that click consumes it.
  const clickSuppression = useClickSuppression({ autoDisarm: false });
  const isGameModal = variant === "game-modal";

  // A held finger opens the row's action menu; the tap the browser then
  // synthesizes is swallowed so it doesn't also fire onSelect.
  const pressAndHold = usePressAndHold<HTMLButtonElement>({
    enabled: mobile && Boolean(onOpenActions),
    onHold: (event) => {
      clickSuppression.arm();
      onOpenActions?.(event, conversation);
    },
  });

  const renderedTitle = displayTitle ?? conversation.title;
  const showInlineActions = isGameModal;
  return (
    <div
      data-testid="conv-item"
      data-active={isActive || undefined}
      className={
        isGameModal
          ? `group relative flex w-full items-start gap-2 rounded-sm border p-2.5 transition-all sm:gap-3 ${
              isActive
                ? "border-[color:var(--first-run-accent-border)] bg-[color:var(--first-run-accent-bg)] "
                : "border-transparent bg-transparent hover:border-white/10 hover:bg-white/5"
            }`
          : `group relative flex w-full items-center gap-2 px-2.5 py-1 text-left transition-colors duration-100 ${
              isActive
                ? "rounded-sm border border-accent/35 bg-[color:color-mix(in_srgb,var(--accent-subtle)_70%,var(--bg)_30%)] text-txt"
                : "rounded-sm border border-transparent bg-[color:color-mix(in_srgb,var(--card)_82%,var(--text)_10%)] text-[color:color-mix(in_srgb,var(--text-strong)_78%,var(--text)_22%)] hover:border-border/45 hover:bg-[color:color-mix(in_srgb,var(--card)_76%,var(--text)_16%)] hover:text-txt"
            }`
      }
    >
      <Button
        variant="ghost"
        size="sm"
        data-testid="conv-select"
        className={
          isGameModal
            ? "flex h-auto w-full min-w-0 flex-1 cursor-pointer flex-col !items-start !justify-start overflow-hidden rounded-none border-none bg-transparent p-0 !text-left"
            : "m-0 flex h-auto w-full min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded-none border-0 bg-transparent p-0 text-left hover:bg-transparent"
        }
        onClick={() => {
          if (clickSuppression.consumeArmed()) return;
          onSelect();
        }}
        onContextMenu={(event) => {
          if (mobile || !onOpenActions) return;
          onOpenActions(event, conversation);
        }}
        {...pressAndHold}
      >
        {isUnread ? (
          <span
            className={
              isGameModal
                ? "absolute left-3 top-3 z-[1] h-2 w-2 shrink-0 rounded-full bg-accent animate-pulse"
                : "h-1.5 w-1.5 shrink-0 rounded-full bg-accent "
            }
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <TruncatingConversationTitle
            displayTitle={renderedTitle}
            isActive={isActive}
            variant={variant}
          />
        </div>
      </Button>
      {!isGameModal && !isConfirmingDelete && onOpenActions ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="conv-actions"
          aria-label={labels.actions ?? "More actions"}
          className={cn(
            "h-6 w-6 shrink-0 rounded-sm p-0 text-muted hover:bg-transparent hover:text-txt ",
            mobile
              ? "opacity-100"
              : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenActions(event, conversation);
          }}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Button>
      ) : null}

      {showInlineActions && !isConfirmingDelete ? (
        <Button
          size="icon"
          variant={isGameModal ? "ghost" : "surface"}
          data-testid="conv-rename"
          aria-label={labels.rename ?? "Rename conversation"}
          className={cn(
            isGameModal
              ? "h-8 w-8 shrink-0 self-center rounded-sm border border-white/10 bg-black/20 text-[color:var(--first-run-text-muted)] transition-[border-color,background-color,color,opacity] hover:border-[color:var(--first-run-accent-border)] hover:bg-[color:var(--first-run-accent-bg)] hover:text-[color:var(--first-run-text-strong)]   "
              : "h-8 w-8 shrink-0 rounded-sm hover:text-accent",
            mobile
              ? "opacity-100"
              : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto  ",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestRename?.();
          }}
        >
          <PencilLine className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
        </Button>
      ) : null}

      {showInlineActions && !isConfirmingDelete ? (
        <Button
          size="icon"
          variant={isGameModal ? "ghost" : "surfaceDestructive"}
          data-testid="conv-delete"
          aria-label={labels.delete ?? "Delete conversation"}
          className={cn(
            isGameModal
              ? "h-8 w-8 shrink-0 self-center rounded-sm border border-white/10 bg-black/20 text-[color:var(--first-run-text-muted)] transition-[border-color,background-color,color,opacity] hover:border-[color:var(--first-run-accent-border)] hover:bg-[color:var(--first-run-accent-bg)] hover:text-[color:var(--first-run-text-strong)]   "
              : "h-8 w-8 shrink-0 rounded-sm",
            mobile
              ? "opacity-100"
              : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto  ",
            "hover:text-danger",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDeleteConfirm?.();
          }}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
        </Button>
      ) : null}

      {isConfirmingDelete ? (
        <div className="flex flex-shrink-0 items-center gap-1.5 rounded-sm border border-danger/30 bg-destructive-subtle px-2 py-1 ">
          <span className="text-2xs font-medium text-danger">
            {labels.deleteConfirm ?? "Delete?"}
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 rounded-sm px-2 py-0.5 text-2xs disabled:opacity-50"
            onClick={() => void onConfirmDelete?.()}
            disabled={deleting}
          >
            {deleting ? "..." : (labels.deleteYes ?? "Yes")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-sm px-2 py-0.5 text-2xs text-muted-strong hover:border-accent/40 hover:text-txt disabled:opacity-50"
            onClick={onCancelDelete}
            disabled={deleting}
          >
            {labels.deleteNo ?? "No"}
          </Button>
        </div>
      ) : null}
    </div>
  );
});
