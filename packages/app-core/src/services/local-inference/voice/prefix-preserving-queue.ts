/**
 * Prefix-preserving TTS rollback queue for barge-in handling.
 *
 * When the user barges in mid-response, the naive approach drops ALL
 * in-flight audio chunks. This queue does better: it tags each audio
 * chunk with the token range it covers, and on barge-in retains chunks
 * whose token range ends at or before the divergence point (the last
 * committed token index when the barge-in fires).
 *
 * If the new user utterance continues the topic, audio up to the
 * divergence point plays smoothly. Chunks for tokens past the divergence
 * are dropped.
 *
 * Data model:
 *
 *   TaggedAudioChunk — a PCM buffer paired with [start, end] token indices
 *     (inclusive) and its duration in milliseconds.
 *
 *   PrefixPreservingQueue — ordered queue of TaggedAudioChunk. On barge-in
 *     with a given divergencePoint:
 *       keep   when chunk.tokenRange[1] <= divergencePoint
 *       drop   when chunk.tokenRange[0] >  divergencePoint
 *       trim   when chunk straddles the point (tokenRange[0] <= point
 *              but tokenRange[1] > point) — kept whole; the scheduler
 *              treats sub-phrase granularity as a best-effort approximation.
 *
 * The old `handleBargeIn` path (ring-buffer drain + full stop) remains
 * active as a fallback when the queue is not wired (e.g. the backend
 * emits chunks without token-range tags). When the queue IS wired, the
 * scheduler calls `rollbackAt(divergencePoint)` instead of a plain drain,
 * and replays the retained prefix into the sink before resuming.
 */

export interface TaggedAudioChunk {
  pcm: Float32Array;
  /**
   * Inclusive token-index range the audio chunk covers.
   * [start, end] where start <= end. Both values are in the
   * scheduler's token-index space (same as `Phrase.fromIndex` /
   * `Phrase.toIndex`).
   */
  tokenRange: [number, number];
  /**
   * Wall-clock duration of this chunk in milliseconds, computed from
   * `pcm.length / sampleRate * 1000`. Stored here so the queue can
   * report total retained duration to telemetry without knowing the
   * sample rate.
   */
  durationMs: number;
}

export interface RollbackResult {
  /** Chunks retained (token range ends at or before divergencePoint). */
  retained: TaggedAudioChunk[];
  /** Chunks dropped (token range starts after divergencePoint). */
  dropped: TaggedAudioChunk[];
  /**
   * Chunks that straddled the divergence point
   * (started at or before, ended after) — kept in `retained` at phrase
   * granularity. Callers can inspect this for telemetry.
   */
  straddled: TaggedAudioChunk[];
  /** Sum of retained chunk durations in milliseconds. */
  retainedDurationMs: number;
  /** Sum of dropped chunk durations in milliseconds. */
  droppedDurationMs: number;
}

/**
 * Prefix-preserving audio chunk queue.
 *
 * Usage:
 *   1. On each audio chunk arriving from the TTS backend, call `enqueue`.
 *   2. On barge-in, call `rollbackAt(divergencePoint)` — returns the
 *      partition of retained vs dropped chunks. The caller replays the
 *      retained prefix into the audio sink and discards the rest.
 *   3. Call `clear()` to reset (e.g. on a new turn).
 *
 * Thread-safety: single-threaded JS — no locking needed.
 */
export class PrefixPreservingQueue {
  private readonly chunks: TaggedAudioChunk[] = [];

  /** Number of chunks currently in the queue. */
  get size(): number {
    return this.chunks.length;
  }

  /**
   * Add a tagged audio chunk to the tail of the queue. Chunks MUST be
   * enqueued in token-range order (ascending `tokenRange[0]`) — the queue
   * does not sort. Violations produce unspecified rollback behaviour.
   */
  enqueue(chunk: TaggedAudioChunk): void {
    this.chunks.push(chunk);
  }

  /**
   * Partition the queue at `divergencePoint` (the last committed token
   * index). Clears the queue and returns the three-way split.
   *
   * Decision per chunk:
   *   chunk.tokenRange[1] <= divergencePoint  → retained (prefix)
   *   chunk.tokenRange[0] >  divergencePoint  → dropped  (post-divergence)
   *   otherwise (straddle)                    → retained (best-effort)
   *
   * After this call the queue is empty. Callers should replay `retained`
   * into the audio sink.
   */
  rollbackAt(divergencePoint: number): RollbackResult {
    const retained: TaggedAudioChunk[] = [];
    const dropped: TaggedAudioChunk[] = [];
    const straddled: TaggedAudioChunk[] = [];
    let retainedDurationMs = 0;
    let droppedDurationMs = 0;

    for (const chunk of this.chunks) {
      const [start, end] = chunk.tokenRange;
      if (end <= divergencePoint) {
        // Fully before or at the divergence point — keep.
        retained.push(chunk);
        retainedDurationMs += chunk.durationMs;
      } else if (start > divergencePoint) {
        // Fully after the divergence point — drop.
        dropped.push(chunk);
        droppedDurationMs += chunk.durationMs;
      } else {
        // Straddles the divergence point — keep at phrase granularity.
        retained.push(chunk);
        straddled.push(chunk);
        retainedDurationMs += chunk.durationMs;
      }
    }

    this.chunks.length = 0;
    return {
      retained,
      dropped,
      straddled,
      retainedDurationMs,
      droppedDurationMs,
    };
  }

  /**
   * Drop all queued chunks without replaying any of them. Used by the
   * hard-stop / full-cancel path as a fallback when the new utterance
   * does not continue the topic.
   */
  clear(): TaggedAudioChunk[] {
    const all = this.chunks.splice(0);
    return all;
  }

  /**
   * Peek at the current queue without modifying it (snapshot for
   * telemetry / tests).
   */
  snapshot(): ReadonlyArray<TaggedAudioChunk> {
    return this.chunks.slice();
  }
}
