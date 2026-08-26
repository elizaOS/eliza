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

// z-[200] mirrors Z_OVERLAY in ../../../lib/floating-layers.ts.
// Tailwind v4 cannot detect classes built from runtime template literals,
// so the value is kept inline so the scanner emits the utility.
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { StatusDot } from "../../ui/status-badge";
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
              isActive ? "text-bg" : "text-white/90 group-hover:text-white"
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
    <Card
      variant={
        isActive ? "insetCompact" : isGameModal ? "panel" : "transparent"
      }
      flow={isGameModal ? "none" : "row"}
      gap={isGameModal ? "none" : "compact"}
      data-testid="conv-item"
      data-active={isActive || undefined}
      className={
        isGameModal
          ? "group relative flex w-full items-start gap-2 transition-all sm:gap-3"
          : "group relative w-full px-2.5 py-1 text-left transition-colors duration-100"
      }
    >
      <Button
        variant="selection"
        size="eventRow"
        data-testid="conv-select"
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
          <StatusDot
            tone="success"
            className={
              isGameModal
                ? "absolute left-3 top-3 z-[1] animate-pulse"
                : "shrink-0"
            }
            aria-label="Unread"
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
          variant="ghostMuted"
          size="micro"
          data-testid="conv-actions"
          aria-label={labels.actions ?? "More actions"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenActions(event, conversation);
          }}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      ) : null}

      {showInlineActions && !isConfirmingDelete ? (
        <Button
          size="icon-sm"
          variant={isGameModal ? "outlineAccent" : "surface"}
          data-testid="conv-rename"
          aria-label={labels.rename ?? "Rename conversation"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestRename?.();
          }}
        >
          <PencilLine className="size-3.5" strokeWidth={2.25} aria-hidden />
        </Button>
      ) : null}

      {showInlineActions && !isConfirmingDelete ? (
        <Button
          size="icon-sm"
          variant={isGameModal ? "dangerOutline" : "surfaceDestructive"}
          data-testid="conv-delete"
          aria-label={labels.delete ?? "Delete conversation"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDeleteConfirm?.();
          }}
        >
          <X className="size-3.5" strokeWidth={2.25} aria-hidden />
        </Button>
      ) : null}

      {isConfirmingDelete ? (
        <Card variant="insetCompact" flow="row" gap="tight">
          <span className="text-2xs font-medium text-txt-strong">
            {labels.deleteConfirm ?? "Delete?"}
          </span>
          <Button
            variant="destructive"
            size="tiny"
            onClick={() => void onConfirmDelete?.()}
            disabled={deleting}
          >
            {deleting ? "..." : (labels.deleteYes ?? "Yes")}
          </Button>
          <Button
            variant="outlineMuted"
            size="tiny"
            onClick={onCancelDelete}
            disabled={deleting}
          >
            {labels.deleteNo ?? "No"}
          </Button>
        </Card>
      ) : null}
    </Card>
  );
});
