/**
 * Internal seams of @elizaos/plugin-meetings.
 *
 * Three layers meet here and nowhere else:
 *  - platforms/ (browser bots) PRODUCE per-speaker 16 kHz PCM + roster events
 *    into a MeetingAudioSink and report lifecycle through MeetingBotSession.
 *  - pipeline/ IMPLEMENTS MeetingAudioSink: per-speaker stream buffering,
 *    ASR via runtime.useModel(TRANSCRIPTION), LocalAgreement confirmation,
 *    hallucination filtering, and TranscriptSegment assembly.
 *  - service.ts ORCHESTRATES: session state machine, transcript persistence,
 *    live event fan-out, actions/routes.
 *
 * Public (cross-package) shapes live in @elizaos/shared (meetings.ts,
 * transcripts.ts) — keep this file plugin-internal.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import type {
  MeetingAutoLeaveConfig,
  MeetingEndReason,
  MeetingParticipant,
  MeetingPlatform,
  MeetingSessionStatus,
} from "@elizaos/shared";
import type { TranscriptSegment } from "@elizaos/shared";

/** Audio produced by every platform adapter: mono Float32 PCM at 16 kHz. */
export const MEETING_AUDIO_SAMPLE_RATE = 16_000;

/**
 * Where platform adapters push captured audio + roster observations.
 * Implemented by the transcription pipeline. All methods are non-blocking;
 * the pipeline owns buffering and backpressure.
 */
export interface MeetingAudioSink {
  /**
   * Push captured PCM for one speaker stream. `speakerKey` is the adapter's
   * stable per-stream key (track index, SSRC, caption author, …) — it does
   * NOT need to be a display name; call `setSpeakerName` once attribution
   * resolves one.
   */
  pushSpeakerAudio(speakerKey: string, samples: Float32Array): void;
  /** Attribute a speaker key to a display name (vote-and-lock result). */
  setSpeakerName(speakerKey: string, displayName: string): void;
  /** Force-finalize a speaker's pending buffer (speaker change, mute, leave). */
  flushSpeaker(speakerKey: string): void;
  /** Roster observation: someone (not the bot) appeared in the meeting. */
  participantJoined(participant: MeetingParticipant): void;
  /** Roster observation: participant left at `atMs` (ms from session start). */
  participantLeft(participantId: string, atMs: number): void;
}

/** Fully-resolved bot configuration (defaults applied). */
export interface ResolvedMeetingBotConfig {
  platform: MeetingPlatform;
  meetingUrl: string;
  nativeMeetingId: string;
  botName: string;
  language?: string;
  autoLeave: MeetingAutoLeaveConfig;
  retainAudio: boolean;
}

/**
 * Everything a platform adapter gets for one meeting: config, the audio sink,
 * an abort signal (user-requested stop → graceful leave), and lifecycle
 * reporting back to the service.
 */
export interface MeetingBotSession {
  readonly id: UUID;
  readonly config: ResolvedMeetingBotConfig;
  readonly sink: MeetingAudioSink;
  /** Aborted when the user requests a stop; adapter must leave gracefully. */
  readonly signal: AbortSignal;
  /** Report a lifecycle transition (joining → awaiting_admission → active …). */
  reportStatus(status: MeetingSessionStatus): void;
}

/**
 * One meeting platform's bot implementation. Separate class per platform —
 * no platform branching inside an adapter.
 */
export interface MeetingPlatformAdapter {
  readonly platform: MeetingPlatform;
  /**
   * Run the full bot lifecycle: join → admission → capture → leave. Resolves
   * with the end reason (never rejects for expected outcomes like admission
   * rejection — those are MeetingEndReasons; throw only for unexpected
   * failures, which the service maps to "error").
   */
  run(session: MeetingBotSession): Promise<MeetingEndReason>;
}

/** Confirmed/pending segment updates emitted by the pipeline. */
export interface PipelineTranscriptUpdate {
  /** Newly confirmed (stable) segments since the last update. */
  confirmed: TranscriptSegment[];
  /** Current mutable tail — replaces any previously reported pending state. */
  pending: TranscriptSegment[];
}

/**
 * The transcription pipeline for one meeting session. Created by the service,
 * handed to the platform adapter as its `sink`.
 */
export interface MeetingTranscriptionPipeline extends MeetingAudioSink {
  /** Subscribe to confirmed/pending segment updates (live view + persistence). */
  onUpdate(listener: (update: PipelineTranscriptUpdate) => void): () => void;
  /**
   * Stop accepting audio, flush every speaker buffer, resolve remaining ASR
   * calls, and return all confirmed segments in start-time order.
   */
  finalize(): Promise<TranscriptSegment[]>;
  /** All distinct speaker display names observed so far. */
  speakerNames(): string[];
}

export interface MeetingPipelineOptions {
  runtime: IAgentRuntime;
  sessionId: UUID;
  /** BCP-47 ASR language hint; auto-detect when absent. */
  language?: string;
  /** Retain raw session audio for the transcript record's audio player. */
  retainAudio: boolean;
}
