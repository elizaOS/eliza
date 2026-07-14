/**
 * Per-message reply, copy, playback, and edit controls. Both panel chat and the
 * continuous overlay use the same neutral liquid-glass plate so revealing a
 * row never swaps between unrelated button treatments. Individual controls
 * stay visually unframed at rest; copy and playback use a quiet selected state.
 * Wired by ChatMessage.
 */
import { Check, Copy, Pencil, Reply, Square, Volume2 } from "lucide-react";
import type * as React from "react";

import { cn } from "../../../lib/utils";
import {
  LIQUID_GLASS_BLUR,
  LIQUID_GLASS_EDGE_SHADOW,
  LIQUID_GLASS_SHEEN,
} from "../../shell/liquid-glass";
import { Button } from "../../ui/button";
import type { ChatMessageLabels } from "./chat-types";

export interface ChatMessageActionsProps {
  appearance?: "rail" | "glass-row";
  canEdit?: boolean;
  canPlay?: boolean;
  /** Show the Reply control — set the composer to reply to this message. */
  canReply?: boolean;
  copied?: boolean;
  labels?: ChatMessageLabels;
  onCopy?: () => void;
  onEdit?: () => void;
  onPlay?: () => void;
  onReply?: () => void;
  /** True while THIS message's audio is playing — flips play → stop (glass-row). */
  playing?: boolean;
}

/**
 * Shared glass material for message actions and the inline editor controls.
 * It reuses the notification-center sheen, blur, and inset edge stack so chat
 * controls read as part of the shell rather than a row of independent bubbles.
 */
export function ChatMessageActionSurface({
  className,
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-xl border border-white/25 bg-black/55 p-0.5 text-white transition-colors duration-150",
        className,
      )}
      style={{
        backgroundImage: LIQUID_GLASS_SHEEN,
        boxShadow: LIQUID_GLASS_EDGE_SHADOW,
        WebkitBackdropFilter: LIQUID_GLASS_BLUR,
        backdropFilter: LIQUID_GLASS_BLUR,
        ...style,
      }}
      {...props}
    />
  );
}

/**
 * One icon control inside the shared plate. The full square remains the hit
 * target while its resting state has no fill; taps stop at the control so the
 * parent message does not re-toggle its reveal state.
 */
function MessageActionButton({
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
        "h-7 w-7 rounded-lg bg-transparent p-0 text-white/65 transition-[background-color,color,transform] duration-150 hover:bg-white/10 hover:text-white active:scale-95",
        active && "bg-white/10 text-white hover:bg-white/15",
      )}
    >
      {icon}
    </Button>
  );
}

export function ChatMessageActions({
  appearance = "rail",
  canEdit = false,
  canPlay = false,
  canReply = false,
  copied = false,
  labels = {},
  onCopy,
  onEdit,
  onPlay,
  onReply,
  playing = false,
}: ChatMessageActionsProps) {
  const copyLabel = labels.copy ?? "Copy message";
  const copiedLabel = labels.copied ?? "Copied!";
  const copiedAriaLabel = labels.copiedAria ?? "Copied to clipboard";
  const replyLabel = labels.reply ?? "Reply";
  const editLabel = labels.edit ?? "Edit message";
  const playLabel = labels.play ?? "Play message";
  const glassRow = appearance === "glass-row";

  return (
    <ChatMessageActionSurface
      data-testid={
        glassRow ? "thread-line-action-surface" : "chat-message-actions"
      }
    >
      {canReply && onReply ? (
        <MessageActionButton
          label={replyLabel}
          testId={glassRow ? "thread-line-reply" : "chat-message-reply"}
          icon={<Reply className="h-3.5 w-3.5" />}
          onClick={onReply}
        />
      ) : null}

      {onCopy ? (
        <MessageActionButton
          label={
            copied
              ? glassRow
                ? copiedLabel
                : copiedAriaLabel
              : glassRow
                ? (labels.copy ?? "Copy")
                : copyLabel
          }
          testId={glassRow ? "thread-line-copy" : undefined}
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
        <MessageActionButton
          label={playing ? "Stop" : glassRow ? "Play audio" : playLabel}
          testId={glassRow ? "thread-line-speak" : undefined}
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
        <MessageActionButton
          label={glassRow ? (labels.edit ?? "Edit") : editLabel}
          testId={glassRow ? "thread-line-edit" : undefined}
          icon={<Pencil className="h-3.5 w-3.5" />}
          onClick={onEdit}
        />
      ) : null}
    </ChatMessageActionSurface>
  );
}
