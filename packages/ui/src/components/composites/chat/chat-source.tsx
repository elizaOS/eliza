import { Crown, MessageSquareText, Mic } from "lucide-react";
import type * as React from "react";

import { cn } from "../../../lib/utils";
import type { ChatVoiceSpeaker } from "./chat-types";

type SourceIconProps = {
  className?: string;
};

export type ChatSourceMeta = {
  badgeClassName: string;
  borderClassName: string;
  iconClassName: string;
  Icon: React.ComponentType<SourceIconProps>;
  label: string;
};

const DEFAULT_CHAT_SOURCE_META: ChatSourceMeta = {
  badgeClassName: "border-accent/25 bg-accent/8 text-muted-strong",
  borderClassName: "border-accent/40",
  iconClassName: "text-accent/85",
  Icon: MessageSquareText,
  label: "Message",
};

const chatSourceMetaRegistry = new Map<string, ChatSourceMeta>();

let chatReactionEmojiRenderer:
  | ((emoji: string) => React.ReactNode | null)
  | null = null;

export function normalizeChatSourceKey(
  source: string | null | undefined,
): string | null {
  if (typeof source !== "string") {
    return null;
  }
  const normalized = source.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function registerChatSourceMetaEntries(
  entries: Record<string, ChatSourceMeta>,
): void {
  for (const [key, meta] of Object.entries(entries)) {
    const normalized = normalizeChatSourceKey(key);
    if (!normalized) {
      continue;
    }
    chatSourceMetaRegistry.set(normalized, meta);
  }
}

export function registerChatReactionEmojiRenderer(
  renderer: ((emoji: string) => React.ReactNode | null) | null,
): void {
  chatReactionEmojiRenderer = renderer;
}

export function renderChatReactionEmoji(emoji: string): React.ReactNode | null {
  return chatReactionEmojiRenderer?.(emoji) ?? null;
}

function toTitleCase(source: string): string {
  return source
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getChatSourceMeta(source: string): ChatSourceMeta {
  const normalized = normalizeChatSourceKey(source);
  const known = normalized ? chatSourceMetaRegistry.get(normalized) : null;
  if (known) return known;
  return {
    ...DEFAULT_CHAT_SOURCE_META,
    label: toTitleCase(source),
  };
}

export function ChatSourceIcon({
  source,
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
  source: string;
}) {
  const meta = getChatSourceMeta(source);
  const Icon = meta.Icon;
  const normalized = normalizeChatSourceKey(source);

  return (
    <span
      data-testid="chat-source-icon"
      data-source={normalized ?? undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        meta.iconClassName,
      )}
      {...(decorative
        ? { "aria-hidden": true }
        : { "aria-label": meta.label, role: "img", title: meta.label })}
    >
      <Icon className={className} />
    </span>
  );
}

/**
 * Picks the best display label for a voice speaker attribution. Returns
 * `null` when the speaker block has no usable label (so callers can skip
 * the badge entirely).
 */
export function resolveChatVoiceSpeakerLabel(
  speaker: ChatVoiceSpeaker | null | undefined,
): string | null {
  if (!speaker) return null;
  const name = typeof speaker.name === "string" ? speaker.name.trim() : "";
  if (name) return name;
  const userName =
    typeof speaker.userName === "string" ? speaker.userName.trim() : "";
  if (userName) return userName;
  return null;
}

/**
 * Compact attribution pill rendered next to a voice-captured user message.
 * Shows the speaker name with a Mic glyph and, when the speaker is the
 * OWNER, a Crown affordance matching the shared `OwnerBadge` styling.
 *
 * R10 §4.1 — surface "who spoke this turn" in the chat transcript so
 * multi-speaker rooms stay legible without leaning on entity ids.
 */
export function ChatVoiceSpeakerBadge({
  speaker,
  className,
  "data-testid": dataTestId,
}: {
  speaker: ChatVoiceSpeaker | null | undefined;
  className?: string;
  "data-testid"?: string;
}) {
  const label = resolveChatVoiceSpeakerLabel(speaker);
  if (!speaker || !label) return null;
  const isOwner = speaker.isOwner === true;
  return (
    <span
      data-testid={dataTestId ?? "chat-voice-speaker"}
      data-owner={isOwner ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border/30 bg-card/40 px-1.5 py-0.5 text-[10px] font-medium text-muted",
        className,
      )}
      title={isOwner ? `${label} (OWNER)` : label}
      role="img"
      aria-label={isOwner ? `${label}, OWNER, spoken` : `${label}, spoken`}
    >
      <Mic className="h-2.5 w-2.5" aria-hidden />
      <span className="text-txt">{label}</span>
      {isOwner ? (
        <Crown
          className="h-2.5 w-2.5 text-accent"
          aria-hidden
          data-testid="chat-voice-speaker-owner-crown"
        />
      ) : null}
    </span>
  );
}
