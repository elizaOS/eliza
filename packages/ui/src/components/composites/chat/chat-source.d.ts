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
export declare function normalizeChatSourceKey(
  source: string | null | undefined,
): string | null;
export declare function registerChatSourceMetaEntries(
  entries: Record<string, ChatSourceMeta>,
): void;
export declare function registerChatReactionEmojiRenderer(
  renderer: ((emoji: string) => React.ReactNode | null) | null,
): void;
export declare function renderChatReactionEmoji(
  emoji: string,
): React.ReactNode | null;
export declare function getChatSourceMeta(source: string): ChatSourceMeta;
export declare function ChatSourceIcon({
  source,
  className,
  decorative,
}: {
  className?: string;
  decorative?: boolean;
  source: string;
}): import("react/jsx-runtime").JSX.Element;
/**
 * Picks the best display label for a voice speaker attribution. Returns
 * `null` when the speaker block has no usable label (so callers can skip
 * the badge entirely).
 */
export declare function resolveChatVoiceSpeakerLabel(
  speaker: ChatVoiceSpeaker | null | undefined,
): string | null;
/**
 * Compact attribution pill rendered next to a voice-captured user message.
 * Shows the speaker name with a Mic glyph and, when the speaker is the
 * OWNER, a Crown affordance matching the shared `OwnerBadge` styling.
 *
 * R10 §4.1 — surface "who spoke this turn" in the chat transcript so
 * multi-speaker rooms stay legible without leaning on entity ids.
 */
export declare function ChatVoiceSpeakerBadge({
  speaker,
  className,
  "data-testid": dataTestId,
}: {
  speaker: ChatVoiceSpeaker | null | undefined;
  className?: string;
  "data-testid"?: string;
}): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=chat-source.d.ts.map
