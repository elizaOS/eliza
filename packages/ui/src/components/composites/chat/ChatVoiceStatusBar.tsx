/**
 * ChatVoiceStatusBar — live status strip shown above the composer while
 * continuous chat is on (R10 §2.3).
 *
 * Surfaces:
 * - status dot (idle / listening / thinking / speaking / interrupting)
 * - live partial transcript
 * - speaker pill (name + OWNER crown when entityId matches owner)
 * - interrupt indicator
 * - latency badge (speechEnd → voiceStart) with traffic-light colouring
 */

import { Crown } from "lucide-react";
import type * as React from "react";
import type { ContinuousChatLatency } from "../../../hooks/useContinuousChat";
import { cn } from "../../../lib/utils";
import type {
  VoiceContinuousStatus,
  VoiceSpeakerMetadata,
} from "../../../voice/voice-chat-types";

export interface ChatVoiceStatusBarProps {
  status: VoiceContinuousStatus;
  interimTranscript?: string;
  speaker?: VoiceSpeakerMetadata | null;
  /** Owner entity id from runtime config; speakers matching get a Crown. */
  ownerEntityId?: string | null;
  latency?: ContinuousChatLatency;
  /** Visible only when continuous mode is on AND we have something to show. */
  visible?: boolean;
  className?: string;
  "data-testid"?: string;
}

const STATUS_DOT_CLASS: Record<VoiceContinuousStatus, string> = {
  idle: "bg-muted/60",
  listening: "bg-ok",
  thinking: "bg-warn animate-pulse",
  speaking: "bg-accent",
  interrupting: "bg-danger animate-pulse",
};

const STATUS_LABEL: Record<VoiceContinuousStatus, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  interrupting: "Interrupting",
};

function latencyTone(
  ms: number | null | undefined,
): "ok" | "warn" | "danger" | "muted" {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "muted";
  if (ms <= 500) return "ok";
  if (ms <= 1500) return "warn";
  return "danger";
}

const TONE_CLASS = {
  ok: "text-ok border-ok/40 bg-ok/10",
  warn: "text-warn border-warn/40 bg-warn/10",
  danger: "text-danger border-danger/40 bg-danger/10",
  muted: "text-muted border-border/30 bg-card/20",
} as const;

function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function ChatVoiceStatusBar({
  status,
  interimTranscript,
  speaker,
  ownerEntityId,
  latency,
  visible = true,
  className,
  "data-testid": dataTestId,
}: ChatVoiceStatusBarProps): React.ReactElement | null {
  if (!visible) return null;

  const speakerEntityId = speaker?.entityId ?? null;
  const isOwnerSpeaking =
    Boolean(ownerEntityId) &&
    Boolean(speakerEntityId) &&
    speakerEntityId === ownerEntityId;
  const speakerName = speaker?.name ?? speaker?.userName ?? null;
  const primaryLatency = latency?.speechEndToVoiceStartMs ?? null;
  const tone = latencyTone(primaryLatency);
  const cached = latency?.firstSegmentCached === true;

  return (
    <div
      data-testid={dataTestId ?? "chat-voice-status-bar"}
      data-status={status}
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border border-border/35 bg-card/40 px-3 py-1.5 text-xs",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          STATUS_DOT_CLASS[status],
        )}
        aria-hidden="true"
        data-testid="chat-voice-status-dot"
      />
      <span
        className="font-medium text-txt"
        data-testid="chat-voice-status-label"
      >
        {STATUS_LABEL[status]}
      </span>

      {speakerName ? (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-card/50 px-2 py-0.5"
          data-testid="chat-voice-speaker-pill"
        >
          {isOwnerSpeaking ? (
            <Crown
              className="h-3 w-3 text-accent"
              aria-label="Owner"
              data-testid="chat-voice-speaker-owner"
            />
          ) : null}
          <span className="text-txt">{speakerName}</span>
        </span>
      ) : null}

      {interimTranscript && interimTranscript.trim().length > 0 ? (
        <span
          className="min-w-0 flex-1 truncate italic text-muted"
          data-testid="chat-voice-interim-transcript"
          title={interimTranscript}
        >
          {interimTranscript}
        </span>
      ) : (
        <span className="flex-1" />
      )}

      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium",
          TONE_CLASS[tone],
        )}
        data-testid="chat-voice-latency-badge"
        data-tone={tone}
        title={
          latency
            ? `speech-end → first-token: ${formatLatency(latency.speechEndToFirstTokenMs)}\n` +
              `speech-end → voice-start: ${formatLatency(latency.speechEndToVoiceStartMs)}\n` +
              `stream → voice-start: ${formatLatency(latency.assistantStreamToVoiceStartMs)}` +
              (cached ? "\nfirst segment served from cache" : "")
            : undefined
        }
      >
        {formatLatency(primaryLatency)}
        {cached ? (
          <span className="text-[9px] uppercase opacity-70">cached</span>
        ) : null}
      </span>
    </div>
  );
}

export default ChatVoiceStatusBar;
