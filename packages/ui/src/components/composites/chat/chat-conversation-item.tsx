import { PencilLine, X } from "lucide-react";
import type React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Z_OVERLAY } from "../../../lib/floating-layers";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { PagePanel } from "../page-panel";
import { ChatSourceIcon } from "./chat-source";
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
          : `block min-w-0 max-w-full flex-1 truncate text-left text-sm font-semibold leading-[1.2] tracking-[-0.01em] transition-colors ${
              isActive
                ? "text-txt"
                : "text-[color:color-mix(in_srgb,var(--text-strong)_88%,var(--text)_12%)] group-hover:text-txt"
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
        className={`z-[${Z_OVERLAY}] max-w-[min(90vw,22rem)] whitespace-normal break-words px-3 py-2 text-sm leading-snug`}
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

export function ChatConversationItem({
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
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  const isGameModal = variant === "game-modal";

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearLongPressTimer();
  }, [clearLongPressTimer]);

  const handleTouchStart = (event: React.TouchEvent<HTMLButtonElement>) => {
    if (!mobile || !onOpenActions) return;
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      suppressClickRef.current = true;
      onOpenActions(event, conversation);
      clearLongPressTimer();
    }, 450);
  };

  const handleTouchEnd = () => {
    clearLongPressTimer();
  };

  const renderedTitle = displayTitle ?? conversation.title;
  const conversationSource =
    typeof conversation.source === "string" && conversation.source.trim()
      ? conversation.source
      : null;
  const showInlineActions = isGameModal;
  const showSourceBadge =
    !isGameModal &&
    conversationSource !== null &&
    conversationSource.trim().toLowerCase() !== "app";
  return (
    <div
      data-testid="conv-item"
      data-active={isActive || undefined}
      className={
        isGameModal
          ? `group relative flex w-full items-start gap-2 rounded-xl border p-2.5 transition-all sm:gap-3 ${
              isActive
                ? "border-[color:var(--onboarding-accent-border)] bg-[color:var(--onboarding-accent-bg)] shadow-[0_14px_28px_rgba(0,0,0,0.2)]"
                : "border-transparent bg-transparent hover:border-white/10 hover:bg-white/5"
            }`
          : `group relative flex w-full items-start justify-start gap-3 rounded-2xl border px-3.5 py-3.5 text-left transition-[border-color,background-color,color,box-shadow,transform] duration-150 focus-within:ring-2 focus-within:ring-accent/35 ${
              isActive
                ? "border-accent/26 bg-[linear-gradient(180deg,rgba(var(--accent-rgb),0.18),rgba(var(--accent-rgb),0.08))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_18px_24px_-22px_rgba(var(--accent-rgb),0.22)] ring-1 ring-inset ring-accent/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_18px_28px_-22px_rgba(0,0,0,0.26),0_0_0_1px_rgba(var(--accent-rgb),0.12)]"
                : "border-border/10 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_18%,transparent),transparent)] text-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-border/28 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_28%,transparent),transparent)] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_14px_20px_-22px_rgba(15,23,42,0.12)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] dark:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_14px_22px_-22px_rgba(0,0,0,0.22)]"
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
            : `m-0 flex h-auto w-full min-w-0 flex-1 cursor-pointer items-start gap-3 overflow-hidden rounded-none border-0 bg-transparent p-0 text-left hover:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 ${
                showSourceBadge ? "pr-8" : ""
              }`
        }
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onSelect();
        }}
        onContextMenu={(event) => {
          if (mobile || !onOpenActions) return;
          onOpenActions(event, conversation);
        }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onTouchMove={handleTouchEnd}
      >
        {isUnread ? (
          <span
            className={
              isGameModal
                ? "absolute left-3 top-3 z-[1] h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_10px_rgba(var(--accent-rgb),0.6)] animate-pulse"
                : "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-accent shadow-[0_0_8px_rgba(var(--accent-rgb),0.35)]"
            }
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <TruncatingConversationTitle
            displayTitle={renderedTitle}
            isActive={isActive}
            variant={variant}
          />
          {!isGameModal ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs-tight font-medium leading-none text-muted/72 [font-variant-numeric:tabular-nums]">
              {conversation.updatedAtLabel ? (
                <span>{conversation.updatedAtLabel}</span>
              ) : null}
              {isUnread ? (
                <PagePanel.Meta compact tone="accent">
                  New
                </PagePanel.Meta>
              ) : null}
            </div>
          ) : null}
        </div>
      </Button>
      {showSourceBadge && conversationSource !== null ? (
        <div className="pointer-events-none absolute right-3.5 top-3.5">
          <ChatSourceIcon source={conversationSource} className="h-4 w-4" />
        </div>
      ) : null}

      {showInlineActions && !isConfirmingDelete ? (
        <Button
          size="icon"
          variant={isGameModal ? "ghost" : "surface"}
          data-testid="conv-rename"
          aria-label={labels.rename ?? "Rename conversation"}
          className={cn(
            isGameModal
              ? "h-8 w-8 shrink-0 self-center rounded-lg border border-white/10 bg-black/20 text-[color:var(--onboarding-text-muted)] shadow-sm transition-[border-color,background-color,color,opacity] hover:border-[color:var(--onboarding-accent-border)] hover:bg-[color:var(--onboarding-accent-bg)] hover:text-[color:var(--onboarding-text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              : "h-8 w-8 shrink-0 rounded-lg hover:text-accent",
            mobile
              ? "opacity-100"
              : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto",
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
              ? "h-8 w-8 shrink-0 self-center rounded-lg border border-white/10 bg-black/20 text-[color:var(--onboarding-text-muted)] shadow-sm transition-[border-color,background-color,color,opacity] hover:border-[color:var(--onboarding-accent-border)] hover:bg-[color:var(--onboarding-accent-bg)] hover:text-[color:var(--onboarding-text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              : "h-8 w-8 shrink-0 rounded-lg",
            mobile
              ? "opacity-100"
              : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto",
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
        <div className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-danger/22 bg-[linear-gradient(180deg,rgba(239,68,68,0.1),rgba(239,68,68,0.04))] px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_16px_-16px_rgba(127,29,29,0.18)]">
          <span className="text-2xs font-medium text-danger">
            {labels.deleteConfirm ?? "Delete?"}
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 rounded-md px-2 py-0.5 text-2xs shadow-sm disabled:opacity-50"
            onClick={() => void onConfirmDelete?.()}
            disabled={deleting}
          >
            {deleting ? "..." : (labels.deleteYes ?? "Yes")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-md px-2 py-0.5 text-2xs text-muted-strong shadow-sm hover:border-accent/40 hover:text-txt disabled:opacity-50"
            onClick={onCancelDelete}
            disabled={deleting}
          >
            {labels.deleteNo ?? "No"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
