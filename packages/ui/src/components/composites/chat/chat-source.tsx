/**
 * Small connector-source glyph (iMessage, Telegram, Discord, voice, owner…)
 * shown on a chat line, plus voice-speaker labelling. Source metadata and key
 * normalization come from chat-source.helpers so icon and bubble outline agree.
 */
import { Crown, Mic } from "lucide-react";

import { cn } from "../../../lib/utils";
import {
  getChatSourceMeta,
  normalizeChatSourceKey,
  resolveChatVoiceSpeakerLabel,
} from "./chat-source.helpers";
import type { ChatVoiceSpeaker } from "./chat-types";

export type { ChatSourceMeta } from "./chat-source.helpers";

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
        "inline-flex items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted",
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
