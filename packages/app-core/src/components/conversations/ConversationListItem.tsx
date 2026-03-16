import { Button, Input } from "@elizaos/ui";
import type React from "react";
import { useRef } from "react";
import { getLocalizedConversationTitle } from "./conversation-utils";

interface ConversationListItemProps {
  conv: { id: string; title: string; updatedAt: string };
  isActive: boolean;
  isEditing: boolean;
  isUnread: boolean;
  isGameModal: boolean;
  editingTitle: string;
  confirmDeleteId: string | null;
  deletingId: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  t: (
    key: string,
    vars?: Record<string, string | number | boolean | null | undefined>,
  ) => string;
  mobile: boolean;
  onSelect: (id: string) => void;
  onEditingTitleChange: (value: string) => void;
  onEditSubmit: (id: string) => void;
  onEditKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onOpenActions: (
    event:
      | React.MouseEvent<HTMLButtonElement | HTMLDivElement>
      | React.TouchEvent<HTMLButtonElement | HTMLDivElement>,
    conv: { id: string; title: string },
  ) => void;
}

export function ConversationListItem({
  conv,
  isActive,
  isEditing,
  isUnread,
  isGameModal,
  editingTitle,
  confirmDeleteId,
  deletingId,
  inputRef,
  t,
  mobile,
  onSelect,
  onEditingTitleChange,
  onEditSubmit,
  onEditKeyDown,
  onConfirmDelete,
  onCancelDelete,
  onOpenActions,
}: ConversationListItemProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLButtonElement>) => {
    if (!mobile) return;
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      onOpenActions(event, conv);
      clearLongPressTimer();
    }, 450);
  };

  const handleTouchEnd = () => {
    clearLongPressTimer();
  };

  return (
    <div
      key={conv.id}
      data-testid="conv-item"
      data-active={isActive || undefined}
      className={`w-full ${
        isGameModal
          ? "group relative flex items-start gap-3 w-full p-2.5 rounded-xl cursor-pointer transition-all border border-transparent"
          : "flex items-center pl-3 pr-2 py-2 gap-1 cursor-pointer transition-colors border-l-[3px]"
      } ${
        isActive
          ? isGameModal
            ? "bg-accent/15 border-accent/30 shadow-[0_0_15px_rgba(240,178,50,0.1)]"
            : "bg-bg-hover border-l-accent"
          : isGameModal
            ? "hover:bg-white/5 hover:border-white/10"
            : "border-l-transparent hover:bg-bg-hover"
      }`}
    >
      {isEditing ? (
        <Input
          ref={inputRef}
          className="w-full h-8 px-1.5 border-accent bg-card text-txt text-[13px] shadow-sm focus-visible:ring-1 focus-visible:ring-accent"
          value={editingTitle}
          onChange={(e) => onEditingTitleChange(e.target.value)}
          onBlur={() => void onEditSubmit(conv.id)}
          onKeyDown={(e) => onEditKeyDown(e, conv.id)}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            data-testid="conv-select"
            className={
              isGameModal
                ? "flex w-full flex-col flex-1 min-w-0 !items-start !justify-start !text-left cursor-pointer h-auto p-0 rounded-none bg-transparent border-none"
                : "flex items-center gap-2 flex-1 min-w-0 bg-transparent border-0 p-0 m-0 text-left h-auto cursor-pointer rounded-none"
            }
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              onSelect(conv.id);
            }}
            onContextMenu={(event) => {
              if (mobile) return;
              onOpenActions(event, conv);
            }}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onTouchMove={handleTouchEnd}
          >
            {isUnread && (
              <span
                className={
                  isGameModal
                    ? "absolute top-3 left-3 w-2 h-2 rounded-full bg-accent animate-pulse shadow-[0_0_8px_rgba(240,178,50,0.8)]"
                    : "w-2 h-2 rounded-full bg-accent shrink-0"
                }
              />
            )}

            <span
              className={
                isGameModal
                  ? `block w-full text-[13px] font-medium truncate leading-tight text-left transition-colors min-w-0 ${isActive ? "text-txt text-shadow-glow" : "text-white/90 group-hover:text-white"}`
                  : "block w-full font-medium truncate text-left text-txt min-w-0"
              }
            >
              {getLocalizedConversationTitle(conv.title, t)}
            </span>
          </Button>

          {confirmDeleteId === conv.id ? (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-[10px] text-danger">
                {t("conversations.deleteConfirm")}
              </span>
              <Button
                variant="destructive"
                size="sm"
                className="h-6 px-1.5 py-0.5 text-[10px] text-white shadow-sm disabled:opacity-50"
                onClick={() => void onConfirmDelete(conv.id)}
                disabled={deletingId === conv.id}
              >
                {deletingId === conv.id ? "..." : t("conversations.deleteYes")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-1.5 py-0.5 text-[10px] text-muted shadow-sm hover:border-accent hover:text-txt disabled:opacity-50"
                onClick={() => onCancelDelete()}
                disabled={deletingId === conv.id}
              >
                {t("conversations.deleteNo")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
