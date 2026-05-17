/**
 * Continuous-chat orchestration on top of `useVoiceChat` (R10 §1, §2.2).
 *
 * WHY a sibling hook (not a refactor of useVoiceChat):
 * - `useVoiceChat` is a 1961-line monolith that already handles STT (Web Speech
 *   + native TalkMode), TTS (ElevenLabs + browser + native), interruption,
 *   cancellation, and audio cache. Rewriting it for this wave is out of scope
 *   and risky — R10 §10 calls this out explicitly.
 * - The continuous-chat semantics (mode switch, status, latency badge, speaker
 *   pill, cancellation token plumbing) are a thin orchestration layer that
 *   reads `useVoiceChat`'s state + invokes its `startListening("passive")` /
 *   `stopListening()` API. Keeping that orchestration in this sibling makes
 *   the diff reviewable and the contract testable.
 *
 * The cancellation token defined here is intentionally minimal (R11 will spec
 * the full cross-layer cancellation contract; this layer only exposes the UI
 * surface). When R11 lands, swap the local `CancellationToken` shape for the
 * runtime one and propagate the abort signal through the cloud relay.
 */
import type { VoiceChatState } from "../voice/voice-chat-types";
import {
  type VoiceContinuousMode,
  type VoiceContinuousStatus,
  type VoiceSpeakerMetadata,
} from "../voice/voice-chat-types";
export interface ContinuousChatLatency {
  /** Speech end → first assistant token, ms. */
  speechEndToFirstTokenMs: number | null;
  /** Speech end → assistant voice playback start, ms. */
  speechEndToVoiceStartMs: number | null;
  /** Assistant stream start → assistant voice playback start, ms. */
  assistantStreamToVoiceStartMs: number | null;
  /** Whether the first speech segment was served from the first-line cache. */
  firstSegmentCached: boolean | null;
}
export interface ContinuousChatCancellationToken {
  /** Stable id for the optimistic turn the token guards. */
  id: string;
  /** Cancel the turn. Idempotent. */
  cancel: (reason: ContinuousChatCancellationReason) => void;
  /** Whether `cancel` has fired. */
  isCancelled: () => boolean;
}
export type ContinuousChatCancellationReason =
  | "user-speech"
  | "user-stop"
  | "mode-changed"
  | "unmounted";
export interface UseContinuousChatOptions {
  /** Underlying full voice-chat hook (already wired by the caller). */
  voice: VoiceChatState;
  /** Continuous-chat mode the user has chosen. */
  mode: VoiceContinuousMode;
  /** Disable continuous-chat capture even if mode is non-off (e.g. composer locked). */
  disabled?: boolean;
  /**
   * Latency snapshot emitted by `useChatVoiceController` (already tracked).
   * Pass it through so the status bar reads from the same source of truth.
   */
  latency?: ContinuousChatLatency;
  /**
   * Live speaker attribution for the in-progress turn, populated by R2's
   * speaker-id pipeline. Falls back to undefined when speaker-id is offline.
   */
  speaker?: VoiceSpeakerMetadata | null;
  /** Most recent assistant message id (drives `speaking` status). */
  assistantMessageId?: string | null;
  /** True while the runtime is generating an assistant reply. */
  assistantGenerating?: boolean;
  /** Called when continuous capture transitions on→off so callers can flush state. */
  onContinuousStop?: (reason: ContinuousChatCancellationReason) => void;
}
export interface ContinuousChatState {
  /** Resolved aggregate status for the status bar. */
  status: VoiceContinuousStatus;
  /** Continuous capture is currently engaged. */
  active: boolean;
  /** Whether the user enabled continuous mode. */
  mode: VoiceContinuousMode;
  /** Live partial transcript while a turn is in progress. */
  interimTranscript: string;
  /** Pulse flag — set briefly when an interrupt fires. */
  interrupting: boolean;
  /** Latency snapshot mirror, suitable for the latency badge. */
  latency: ContinuousChatLatency;
  /** Speaker attribution mirror. */
  speaker: VoiceSpeakerMetadata | null;
  /** Start a new optimistic turn (R11 cancellation contract surface). */
  startTurn: () => ContinuousChatCancellationToken;
  /** Manually stop continuous capture without resetting `mode`. */
  pause: () => Promise<void>;
  /** Resume continuous capture after a manual pause. */
  resume: () => Promise<void>;
}
/**
 * Compose `useVoiceChat` with continuous-chat orchestration. Mode resolution:
 *
 * - `off`         → idle (push-to-talk only; capture is owned by composer).
 * - `vad-gated`   → mic enters `passive` mode on demand, closes on EOT.
 * - `always-on`   → mic enters `passive` mode and stays there as long as the
 *                   component is mounted and not disabled.
 */
export declare function useContinuousChat(
  options: UseContinuousChatOptions,
): ContinuousChatState;
//# sourceMappingURL=useContinuousChat.d.ts.map
