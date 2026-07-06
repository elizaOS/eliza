/**
 * Per-message action controls (copy / play / edit / delete), in the two chromes
 * the chat surfaces use: `rail` — the hover `PagePanel.ActionRail` overlaying a
 * panel bubble (ChatView / detached windows) — and `glass-row` — the continuous
 * overlay's tap-revealed row of round icon buttons beneath a glass bubble
 * (#10713). Each control is opt-in via its `can*` flag; copy shows a transient
 * confirmed state; play toggles to stop on the bubble that is speaking
 * (`playing`, glass-row only). Wired by ChatMessage.
 */
import {
  Check,
  Copy,
  Pencil,
  Reply,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import type * as React from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { PagePanel } from "../page-panel";
import type { ChatMessageLabels } from "./chat-types";

export interface ChatMessageActionsProps {
  appearance?: "rail" | "glass-row";
  canDelete?: boolean;
  canEdit?: boolean;
  canPlay?: boolean;
  /** Show the Reply control — set the composer to reply to this message. */
  canReply?: boolean;
  copied?: boolean;
  labels?: ChatMessageLabels;
  onCopy?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  onPlay?: () => void;
  onReply?: () => void;
  /** True while THIS message's audio is playing — flips play → stop (glass-row). */
  playing?: boolean;
}

/**
 * One icon-only control in the glass action row: no card fill, neutral resting
 * → neutral-opacity hover; an active (e.g. playing) control tints with the
 * orange accent. `stopPropagation` keeps a tap on the button from re-toggling
 * the row or ending text selection.
 */
function GlassActionButton({
  label,
  icon,
  onClick,
  active,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  testId?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "h-7 w-7 rounded-full p-0 transition-colors",
        active
          ? "bg-[rgb(255,88,0)]/25 text-white"
          : "bg-white/10 text-white/80 hover:bg-white/20",
      )}
    >
      {icon}
    </Button>
  );
}

export function ChatMessageActions({
  appearance = "rail",
  canDelete = false,
  canEdit = false,
  canPlay = false,
  canReply = false,
  copied = false,
  labels = {},
  onCopy,
  onDelete,
  onEdit,
  onPlay,
  onReply,
  playing = false,
}: ChatMessageActionsProps) {
  const copyLabel = labels.copy ?? "Copy message";
  const copiedLabel = labels.copied ?? "Copied!";
  const copiedAriaLabel = labels.copiedAria ?? "Copied to clipboard";
  const replyLabel = labels.reply ?? "Reply";

  if (appearance === "glass-row") {
    return (
      <>
        {canReply && onReply ? (
          <GlassActionButton
            label={replyLabel}
            testId="thread-line-reply"
            icon={<Reply className="h-3.5 w-3.5" />}
            onClick={onReply}
          />
        ) : null}
        {onCopy ? (
          <GlassActionButton
            label={copied ? "Copied" : "Copy"}
            testId="thread-line-copy"
            icon={
              copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )
            }
            onClick={onCopy}
            active={copied}
          />
        ) : null}
        {canPlay && onPlay ? (
          <GlassActionButton
            label={playing ? "Stop" : "Play audio"}
            testId="thread-line-speak"
            icon={
              playing ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )
            }
            onClick={onPlay}
            active={playing}
          />
        ) : null}
        {canEdit && onEdit ? (
          <GlassActionButton
            label="Edit"
            testId="thread-line-edit"
            icon={<Pencil className="h-3.5 w-3.5" />}
            onClick={onEdit}
          />
        ) : null}
        {canDelete && onDelete ? (
          <GlassActionButton
            label={labels.delete ?? "Delete"}
            testId="thread-line-delete"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={onDelete}
          />
        ) : null}
      </>
    );
  }

  return (
    <PagePanel.ActionRail className="top-1 rounded-sm p-1">
      {canReply && onReply ? (
        <Button
          variant="surface"
          size="icon"
          onClick={onReply}
          className="h-8 w-8 rounded-sm"
          title={replyLabel}
          aria-label={replyLabel}
          data-testid="chat-message-reply"
        >
          <Reply className="h-3.5 w-3.5" />
        </Button>
      ) : null}

      <Button
        variant="surface"
        size="icon"
        onClick={onCopy}
        className="h-8 w-8 rounded-sm"
        title={copied ? copiedLabel : copyLabel}
        aria-label={copied ? copiedAriaLabel : copyLabel}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-ok" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>

      {canPlay ? (
        <Button
          variant="surface"
          size="icon"
          onClick={onPlay}
          className="h-8 w-8 rounded-sm"
          title={labels.play ?? "Play message"}
          aria-label={labels.play ?? "Play message"}
        >
          <Volume2 className="h-3.5 w-3.5" />
        </Button>
      ) : null}

      {canEdit ? (
        <Button
          variant="surface"
          size="icon"
          onClick={onEdit}
          className="h-8 w-8 rounded-sm"
          title={labels.edit ?? "Edit message"}
          aria-label={labels.edit ?? "Edit message"}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      ) : null}

      {canDelete ? (
        <Button
          variant="surfaceDestructive"
          size="icon"
          onClick={onDelete}
          className="h-8 w-8 rounded-sm"
          title={labels.delete ?? "Delete message"}
          aria-label={labels.delete ?? "Delete message"}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </PagePanel.ActionRail>
  );
}
