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

import {
  AlertTriangle,
  Crown,
  PauseCircle,
  Radio,
  RefreshCw,
  VolumeX,
} from "lucide-react";
import type * as React from "react";
import type { ContinuousChatLatency } from "../../../hooks/useContinuousChat";
import { cn } from "../../../lib/utils";
import {
  hasLiveNativeTranscriptContent,
  LiveNativeTranscriptView,
  useLiveNativeTranscript,
} from "../../../native-transcript/LiveNativeTranscript";
import type {
  VoiceContinuousStatus,
  VoiceSpeakerMetadata,
  VoiceTtsError,
} from "../../../voice/voice-chat-types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { StatusDot, type StatusVariant } from "../../ui/status-badge";

/** User-facing label per failed engine for the fail-closed TTS banner (#12253). */
const TTS_ERROR_ENGINE_LABEL: Record<VoiceTtsError["engine"], string> = {
  "eliza-cloud": "Eliza Cloud voice",
  "local-inference": "on-device voice",
  elevenlabs: "ElevenLabs voice",
  "native-talkmode": "voice",
};

export interface ChatVoiceStatusBarProps {
  status: VoiceContinuousStatus;
  interimTranscript?: string;
  speaker?: VoiceSpeakerMetadata | null;
  /** Owner entity id from runtime config; speakers matching get a Crown. */
  ownerEntityId?: string | null;
  latency?: ContinuousChatLatency;
  /**
   * Assistant audio is blocked by the browser autoplay policy. Shows a "tap to
   * enable sound" hint; if `onUnlockAudio` is set the hint is a button.
   */
  needsAudioUnlock?: boolean;
  /** Click handler for the audio-unlock hint (e.g. resume the AudioContext). */
  onUnlockAudio?: () => void;
  /** Transient pulse: browser speech recognition silently auto-reconnected. */
  micReconnected?: boolean;
  /**
   * Set when the configured TTS engine failed and playback was stopped WITHOUT
   * substituting another voice (#12253). Rendered as a danger banner; forces the
   * bar visible so a silent failure is never invisible.
   */
  ttsError?: VoiceTtsError | null;
  /**
   * True while a realtime WebSocket voice session is the active mic path (as
   * opposed to the batch ASR path). Renders a small "Live" pill so the realtime
   * mode is legible — same status vocabulary, just an extra affordance. Purely
   * additive: when false the bar is byte-for-byte the existing batch bar.
   */
  realtimeActive?: boolean;
  /**
   * True while a started realtime session is still connecting (consent, mint,
   * socket, server ready, mic bring-up). Renders a "Connecting" pill so the
   * pre-live window is legible instead of masquerading as Live or idle.
   */
  realtimeConnecting?: boolean;
  /** True when realtime is eligible/selected but the socket is not connected yet. */
  realtimeEligible?: boolean;
  /**
   * True when the realtime session is paused by a visibility-hide (a paused
   * state, NOT a broken one). Renders a "Paused" pill instead of a dead bar.
   */
  realtimePaused?: boolean;
  /**
   * A realtime error message — actionable (mic blocked, connection dropped) or
   * not (consent/mint failure). ALWAYS rendered as a danger pill so a failed
   * realtime session is never silent (UI three-state rule).
   */
  realtimeErrorMessage?: string | null;
  /** Non-blocking notice when this interaction handed the mic to batch voice. */
  realtimeFallbackReason?: string | null;
  /** Visible only when continuous mode is on AND we have something to show. */
  visible?: boolean;
  className?: string;
  "data-testid"?: string;
}

const STATUS_DOT_CLASS: Record<VoiceContinuousStatus, StatusVariant> = {
  idle: "muted",
  listening: "success",
  thinking: "warning",
  speaking: "success",
  interrupting: "danger",
  transcribing: "warning",
};

const STATUS_LABEL: Record<VoiceContinuousStatus, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  interrupting: "Interrupting",
  transcribing: "Transcribing",
};

function latencyTone(
  ms: number | null | undefined,
): "ok" | "warn" | "danger" | "muted" {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "muted";
  if (ms <= 500) return "ok";
  if (ms <= 1500) return "warn";
  return "danger";
}

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
  needsAudioUnlock = false,
  onUnlockAudio,
  micReconnected = false,
  ttsError = null,
  realtimeActive = false,
  realtimeConnecting = false,
  realtimeEligible = false,
  realtimePaused = false,
  realtimeErrorMessage = null,
  realtimeFallbackReason = null,
  visible = true,
  className,
  "data-testid": dataTestId,
}: ChatVoiceStatusBarProps): React.ReactElement | null {
  const nativeTranscript = useLiveNativeTranscript();
  const hasNativeTranscript = hasLiveNativeTranscriptContent(
    nativeTranscript.view,
  );
  // A fail-closed TTS error must always show, even if the bar is otherwise
  // hidden — a silenced voice with no explanation is exactly the bug (#12253).
  if (!visible && !ttsError) return null;

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
    <Card
      variant="insetCompact"
      flow="row"
      gap="compact"
      data-testid={dataTestId ?? "chat-voice-status-bar"}
      data-status={status}
      role="status"
      aria-live="polite"
      className={cn("flex-wrap text-xs", className)}
    >
      <StatusDot
        tone={STATUS_DOT_CLASS[status]}
        aria-hidden="true"
        data-testid="chat-voice-status-dot"
      />
      <span
        className="font-medium text-txt"
        data-testid="chat-voice-status-label"
      >
        {STATUS_LABEL[status]}
      </span>

      {realtimeActive ? (
        realtimePaused ? (
          <Badge
            variant="outline"
            tone="warning"
            data-testid="chat-voice-realtime-paused"
          >
            <PauseCircle className="size-3" aria-hidden="true" />
            <span>Paused</span>
          </Badge>
        ) : (
          <Badge
            variant="outline"
            tone="accent"
            data-testid="chat-voice-realtime-live"
            title="Realtime voice session"
          >
            <Radio className="size-3" aria-hidden="true" />
            <span>Live</span>
          </Badge>
        )
      ) : realtimeConnecting ? (
        <Badge
          variant="outline"
          tone="accent"
          data-testid="chat-voice-realtime-connecting"
          title="Realtime voice session connecting"
        >
          <Radio className="size-3 animate-pulse" aria-hidden="true" />
          <span>Connecting</span>
        </Badge>
      ) : realtimeEligible ? (
        <Badge
          variant="outline"
          tone="accent"
          data-testid="chat-voice-realtime-armed"
          title="Realtime voice armed, connecting on mic start"
        >
          <Radio className="size-3" aria-hidden="true" />
          <span>Realtime armed</span>
        </Badge>
      ) : null}

      {realtimeFallbackReason ? (
        <Badge
          variant="outline"
          tone="warning"
          data-testid="chat-voice-realtime-fallback"
          data-reason={realtimeFallbackReason}
          title={`Realtime fallback reason: ${realtimeFallbackReason}`}
        >
          <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">
            Realtime voice unavailable, using standard voice mode
          </span>
        </Badge>
      ) : null}

      {realtimeErrorMessage ? (
        <Badge
          variant="outline"
          tone="danger"
          data-testid="chat-voice-realtime-error"
          title={realtimeErrorMessage}
        >
          <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{realtimeErrorMessage}</span>
        </Badge>
      ) : null}

      {ttsError ? (
        <Badge
          variant="outline"
          tone="danger"
          data-testid="chat-voice-tts-error"
          data-engine={ttsError.engine}
          title={ttsError.message}
        >
          <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {TTS_ERROR_ENGINE_LABEL[ttsError.engine]} unavailable
          </span>
        </Badge>
      ) : null}

      {speakerName ? (
        <Badge
          variant="outline"
          tone="muted"
          data-testid="chat-voice-speaker-pill"
        >
          {isOwnerSpeaking ? (
            <Crown
              className="size-3 text-accent"
              aria-label="Owner"
              data-testid="chat-voice-speaker-owner"
            />
          ) : null}
          <span className="text-txt">{speakerName}</span>
        </Badge>
      ) : null}

      {micReconnected ? (
        <Badge
          variant="outline"
          tone="muted"
          data-testid="chat-voice-mic-reconnected"
        >
          <RefreshCw className="size-3" aria-hidden="true" />
          <span>Mic reconnected</span>
        </Badge>
      ) : null}

      {needsAudioUnlock ? (
        onUnlockAudio ? (
          <Button
            variant="warningOutline"
            size="micro"
            onClick={onUnlockAudio}
            data-testid="chat-voice-audio-unlock"
          >
            <VolumeX className="size-3" aria-hidden="true" />
            <span>Tap to enable sound</span>
          </Button>
        ) : (
          <Badge
            variant="outline"
            tone="warning"
            data-testid="chat-voice-audio-unlock"
          >
            <VolumeX className="size-3" aria-hidden="true" />
            <span>Tap anywhere to enable sound</span>
          </Badge>
        )
      ) : null}

      {!hasNativeTranscript &&
      interimTranscript &&
      interimTranscript.trim().length > 0 ? (
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

      <Badge
        variant="outline"
        size="compact"
        tone={tone === "ok" ? "success" : tone === "warn" ? "warning" : tone}
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
          <span className="text-3xs uppercase tracking-wider opacity-70">
            cached
          </span>
        ) : null}
      </Badge>

      {hasNativeTranscript ? (
        <LiveNativeTranscriptView snapshot={nativeTranscript} />
      ) : null}
    </Card>
  );
}

export default ChatVoiceStatusBar;
