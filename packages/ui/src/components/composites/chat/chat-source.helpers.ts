/**
 * Non-JSX helpers for chat message provenance and voice speakers: a pluggable
 * registry mapping a source key (imessage/telegram/…) to badge styling + icon,
 * a pluggable reaction-emoji renderer, source-key normalization, and
 * speaker-label resolution. The registry/renderer are injected by the host app
 * so this UI package carries no connector-specific assets; consumed by
 * chat-source.tsx and chat-message.tsx.
 */
import { MessageSquareText } from "lucide-react";
import type * as React from "react";

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

export function hasChatSourceMeta(source: string): boolean {
  const normalized = normalizeChatSourceKey(source);
  return normalized ? chatSourceMetaRegistry.has(normalized) : false;
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
