/**
 * Per-message reply, copy, playback, and edit controls. Panel chat groups the
 * controls on a neutral liquid-glass plate; the continuous overlay renders a
 * bare icon lane beneath each message so hover and touch affordances stay
 * visually quiet. Copy and playback retain their compact state transitions.
 * Wired by ChatMessage.
 */
import { Check, Copy, Pencil, Reply, Square, Volume2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";

import { cn } from "../../../lib/utils";
import { LIQUID_GLASS_SHEEN } from "../../shell/liquid-glass";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
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
  /** Quiet live state placed after the icon controls in the same action rail. */
  trailingAccessory?: React.ReactNode;
}

/**
 * Shared action container for the material panel and the overlay's bare lane.
 * Inline editor controls retain the notification-center glass stack, while
 * message actions can opt out without duplicating their interaction wiring.
 */
export function ChatMessageActionSurface({
  bare = false,
  className,
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { bare?: boolean }) {
  return (
    <Card
      variant={bare ? "transparent" : "panel"}
      elevation={bare ? undefined : "liquidGlass"}
      flow="row"
      className={cn(
        "inline-flex text-white",
        bare ? "gap-0" : "gap-0.5 p-0.5 transition-colors duration-150",
        className,
      )}
      style={
        bare
          ? style
          : {
              backgroundImage: LIQUID_GLASS_SHEEN,
              ...style,
            }
      }
      {...props}
    />
  );
}

/**
 * One icon control with a full hit target and an unframed resting state. Taps
 * stop at the control so the parent message does not re-toggle its reveal.
 */
function MessageActionButton({
  label,
  icon,
  onClick,
  active,
  bare,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  bare?: boolean;
  testId?: string;
}) {
  return (
    <Button
      variant={active ? "surfaceAccent" : "ghostMuted"}
      size={bare ? "disclosure" : "icon-sm"}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
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
  trailingAccessory,
}: ChatMessageActionsProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const copyLabel = labels.copy ?? "Copy message";
  const copiedLabel = labels.copied ?? "Copied!";
  const copiedAriaLabel = labels.copiedAria ?? "Copied to clipboard";
  const replyLabel = labels.reply ?? "Reply";
  const editLabel = labels.edit ?? "Edit message";
  const playLabel = labels.play ?? "Play message";
  const glassRow = appearance === "glass-row";

  return (
    <ChatMessageActionSurface
      bare={glassRow}
      data-testid={
        glassRow ? "thread-line-action-surface" : "chat-message-actions"
      }
    >
      {canReply && onReply ? (
        <MessageActionButton
          label={replyLabel}
          testId={glassRow ? "thread-line-reply" : "chat-message-reply"}
          icon={<Reply className="size-3.5" />}
          onClick={onReply}
          bare={glassRow}
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
            <span className="relative flex  size-3.5 items-center justify-center">
              <AnimatePresence initial={false}>
                <motion.span
                  key={copied ? "copied" : "copy"}
                  data-testid="copy-status-icon"
                  data-state={copied ? "copied" : "idle"}
                  initial={
                    reduceMotion
                      ? false
                      : {
                          opacity: 0,
                          transform: `rotate(${copied ? -8 : 8}deg) scale(0.76)`,
                        }
                  }
                  animate={{ opacity: 1, transform: "rotate(0deg) scale(1)" }}
                  exit={
                    reduceMotion
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          transform: `rotate(${copied ? 8 : -8}deg) scale(0.76)`,
                        }
                  }
                  transition={{
                    duration: reduceMotion ? 0.08 : 0.16,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  className="absolute inset-0 flex items-center justify-center"
                >
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
          }
          onClick={onCopy}
          bare={glassRow}
        />
      ) : null}

      {canPlay && onPlay ? (
        <MessageActionButton
          label={playing ? "Stop" : glassRow ? "Play audio" : playLabel}
          testId={glassRow ? "thread-line-speak" : undefined}
          icon={
            playing ? (
              <Square className="size-3.5" />
            ) : (
              <Volume2 className="size-3.5" />
            )
          }
          onClick={onPlay}
          active={playing}
          bare={glassRow}
        />
      ) : null}

      {canEdit && onEdit ? (
        <MessageActionButton
          label={glassRow ? (labels.edit ?? "Edit") : editLabel}
          testId={glassRow ? "thread-line-edit" : undefined}
          icon={<Pencil className="size-3.5" />}
          onClick={onEdit}
          bare={glassRow}
        />
      ) : null}

      {trailingAccessory ? (
        <div
          data-testid="thread-line-action-accessory"
          className="ml-0.5 min-w-0 shrink-0"
        >
          {trailingAccessory}
        </div>
      ) : null}
    </ChatMessageActionSurface>
  );
}
