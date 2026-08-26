/**
 * Message surface for a single chat line, toned for assistant vs user and kept
 * chat-native: assistant turns render as plain text (no card fill, no box) and
 * only the user turn carries a subtle accent tint. Two variants: `panel`
 * (theme tokens, ChatView / detached windows / ChatSurface) and `glass` (the
 * continuous overlay's floating row — fixed light text + text shadow, never
 * theme `--txt`, so it stays legible over any wallpaper). When a connector
 * `source` is set the panel chrome draws a source-colored outline so
 * cross-channel messages stay visually distinct without a repeated text badge.
 */
import type * as React from "react";

import { cn } from "../../../lib/utils";
import { WALLPAPER_FLOAT_SHADOW } from "../../shell/wallpaper-idiom";
import { Card } from "../../ui/card";
import { normalizeChatSourceKey } from "./chat-source.helpers";

/** @deprecated Use WALLPAPER_FLOAT_SHADOW from shell/wallpaper-idiom instead. */
export const GLASS_FLOAT_SHADOW = WALLPAPER_FLOAT_SHADOW;

/** The overlay's shared easing for cheap (opacity/translate-only) motion. */
export const GLASS_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export type ChatBubbleTone = "assistant" | "user";
export type ChatBubbleVariant = "panel" | "glass";
export type ChatBubbleAppearance =
  | "default"
  | "firstRun"
  | "game"
  | "gameTyping"
  | "suggestion";

export interface ChatBubbleProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Canonical product treatment for specialized chat contexts. */
  appearance?: ChatBubbleAppearance;
  tone?: ChatBubbleTone;
  /** Chrome: theme-token `panel` (default) or the overlay's floating `glass`. */
  variant?: ChatBubbleVariant;
  /**
   * Source channel the message came from (e.g. "imessage", "telegram",
   * "discord", "whatsapp"). When set, the bubble renders a connector-
   * colored outline so cross-channel messages stay visually distinct
   * without adding a repeated text badge above every message.
   */
  source?: string;
  /**
   * Drop the bubble chrome entirely for `variant="glass"` so the message reads
   * as plain floating text on the wallpaper. First-run onboarding uses this
   * mode when the agent text should sit directly above its CTA button instead of
   * inside a chat card.
   */
  bare?: boolean;
}

export function ChatBubble({
  appearance = "default",
  tone = "assistant",
  variant = "panel",
  source,
  bare = false,
  className,
  ...props
}: ChatBubbleProps) {
  const normalizedSource = normalizeChatSourceKey(source) ?? undefined;

  if (variant === "glass") {
    return (
      <Card
        variant={
          appearance === "firstRun"
            ? "panel"
            : appearance === "suggestion"
              ? "dashed"
              : undefined
        }
        surface={
          appearance === "firstRun" || appearance === "suggestion"
            ? undefined
            : "transparent"
        }
        padding={
          appearance === "default" && !bare && tone === "user"
            ? "compact"
            : undefined
        }
        wallpaperText
        className={cn(
          // whitespace-pre-wrap keeps newlines; overflow-wrap breaks long URLs /
          // hashes / paths so they can't blow out the bubble width on a phone.
          "relative w-fit max-w-full whitespace-pre-wrap text-chat-body [overflow-wrap:anywhere]",
          appearance === "default" && !bare && tone === "assistant" && "py-1",
          appearance === "default" &&
            !bare &&
            tone === "user" &&
            "rounded-2xl rounded-br-md border border-white/15",
          // Message text must remain selectable for normal highlight/copy.
          "select-text [-webkit-touch-callout:default]",
          WALLPAPER_FLOAT_SHADOW,
          className,
        )}
        data-chat-source={normalizedSource ?? undefined}
        {...props}
      />
    );
  }

  return (
    <Card
      variant={
        appearance === "suggestion"
          ? "dashed"
          : appearance === "game" || appearance === "gameTyping"
            ? tone === "user"
              ? "insetCompact"
              : "panel"
            : tone === "user" || normalizedSource
              ? "insetCompact"
              : "transparent"
      }
      tone={tone === "user" ? "strong" : "text"}
      className={cn(
        "relative inline-block max-w-full whitespace-pre-wrap break-words",
        // Chat-native: assistant turns are plain text on the page — no card
        // fill, no box (#13560 de-slop). The user turn keeps its subtle accent
        // tint so the reader can scan who said what at a glance.
        className,
      )}
      data-chat-source={normalizedSource ?? undefined}
      {...props}
    />
  );
}
