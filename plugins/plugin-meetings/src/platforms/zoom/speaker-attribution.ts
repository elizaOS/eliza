/**
 * Zoom Web speaker attribution: the web client exposes ONE mixed audio
 * stream and an active-speaker tile in the DOM. The strategies poll the
 * tile name every ~2 s and feed it here; audio chunks are attributed to a
 * rotating segment key that advances on speaker changes.
 *
 * Vote-and-lock: a candidate name must be observed on consecutive polls
 * (default 2 → ≈4 s) before the segment flips to it. This filters the
 * momentary tile flicker Zoom produces when someone coughs or a tile
 * re-renders — the DOM active-speaker signal ported from Vexa
 * (zoom/web/recording.ts startSpeakerPolling, Apache-2.0) is noisy at the
 * single-poll level.
 */

import type { MeetingAudioSink } from "../../types.js";

export interface ZoomSpeakerAttributorOptions {
  sink: MeetingAudioSink;
  /** Consecutive identical polls required to lock a new speaker (default 2). */
  voteThreshold?: number;
}

export class ZoomSpeakerAttributor {
  private readonly sink: MeetingAudioSink;
  private readonly voteThreshold: number;

  private segmentIndex = 0;
  private lockedName: string | null = null;
  private candidateName: string | null = null;
  private candidateVotes = 0;
  private segmentNamed = false;

  constructor(options: ZoomSpeakerAttributorOptions) {
    this.sink = options.sink;
    this.voteThreshold = options.voteThreshold ?? 2;
  }

  /** Current segment key audio is attributed to. */
  get currentKey(): string {
    return `zoom-speaker-${this.segmentIndex}`;
  }

  /** Currently locked speaker display name, if any. */
  get currentSpeaker(): string | null {
    return this.lockedName;
  }

  /** Push a mixed-stream PCM chunk into the current segment. */
  onAudioChunk(samples: Float32Array): void {
    this.sink.pushSpeakerAudio(this.currentKey, samples);
  }

  /**
   * One active-speaker poll observation. `name` is the tile label or null
   * when no tile is active (silence). Null never breaks a lock — silence
   * between sentences must not fragment a speaker's segment.
   */
  onActiveSpeakerPoll(name: string | null): void {
    const trimmed = name?.trim() || null;
    if (!trimmed) {
      this.candidateName = null;
      this.candidateVotes = 0;
      return;
    }

    if (trimmed === this.lockedName) {
      this.candidateName = null;
      this.candidateVotes = 0;
      return;
    }

    if (trimmed === this.candidateName) {
      this.candidateVotes += 1;
    } else {
      this.candidateName = trimmed;
      this.candidateVotes = 1;
    }

    // First-ever speaker locks immediately — there is no previous segment to
    // protect, and waiting drops the opening words' attribution.
    const required = this.lockedName === null ? 1 : this.voteThreshold;
    if (this.candidateVotes >= required) {
      this.lockTo(trimmed);
    }
  }

  /** Flush the active segment (call at teardown). */
  finalize(): void {
    this.sink.flushSpeaker(this.currentKey);
  }

  private lockTo(name: string): void {
    if (this.lockedName !== null) {
      // Close out the previous speaker's segment and rotate the key.
      this.sink.flushSpeaker(this.currentKey);
      this.segmentIndex += 1;
      this.segmentNamed = false;
    }
    this.lockedName = name;
    this.candidateName = null;
    this.candidateVotes = 0;
    if (!this.segmentNamed) {
      this.sink.setSpeakerName(this.currentKey, name);
      this.segmentNamed = true;
    }
  }
}
