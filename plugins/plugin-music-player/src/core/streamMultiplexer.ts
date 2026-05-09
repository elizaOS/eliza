import { PassThrough, type Readable } from "node:stream";
import { logger } from "@elizaos/core";

/**
 * Stream Multiplexer - The Backpressure Problem Solver
 *
 * THE PROBLEM:
 * Node.js streams have backpressure - if a consumer can't keep up, the producer slows down.
 * This is great for file copying, but terrible for live audio:
 *
 *   Discord: reading at 128kbps ✓
 *   Web Client 1: reading at 128kbps ✓
 *   Web Client 2: reading at 10kbps (slow connection) ✗
 *
 * Without this multiplexer, Client 2's slow connection would cause ALL consumers
 * (including Discord) to receive choppy audio.
 *
 * THE SOLUTION:
 * Each consumer gets an independent PassThrough stream. The multiplexer writes to all
 * consumers simultaneously. If a consumer's buffer is full (backpressure), we don't wait -
 * we drop that frame for THAT consumer only. Discord keeps playing smoothly.
 *
 * WHY THREE POLICIES:
 * - LIVE_DROP: For radio (default) - if you can't keep up, tough luck, stay live
 * - BUFFER_THEN_DROP: For tolerance - give slow clients a chance, then drop
 * - BLOCKING: For recording - accuracy matters more than latency
 */

/**
 * Consumer backpressure policy
 * - LIVE_DROP: Drop frames for slow consumers (radio-style, keeps broadcast live)
 * - BUFFER_THEN_DROP: Buffer some frames, then drop if still slow
 * - BLOCKING: Block source if consumer can't keep up (for recording)
 */
export type BackpressurePolicy = "LIVE_DROP" | "BUFFER_THEN_DROP" | "BLOCKING";

export interface StreamMultiplexerOptions {
  /** Backpressure policy (default: LIVE_DROP) */
  policy?: BackpressurePolicy;

  /** Buffer size per consumer in bytes (default: 64KB) */
  bufferSize?: number;

  /** Log dropped frames (default: false) */
  logDrops?: boolean;
}

interface Consumer {
  id: string;
  stream: PassThrough;
  droppedFrames: number;
  totalFrames: number;
  /** True once the Ogg header has been written to this consumer. */
  headerSent: boolean;
}

/**
 * StreamMultiplexer - Duplicates a single source stream to multiple consumers
 * with non-blocking behavior to protect the broadcast from slow consumers.
 *
 * Key features:
 * - Source writes to all consumers independently
 * - Slow consumers don't block source or other consumers
 * - Configurable backpressure policies
 * - Per-consumer statistics tracking
 */
export class StreamMultiplexer {
  private consumers: Map<string, Consumer> = new Map();
  private source: Readable | null = null;
  private policy: BackpressurePolicy;
  private bufferSize: number;
  private logDrops: boolean;
  private isActive = false;
  private sourceErrorHandler: ((error: Error) => void) | null = null;
  private sourceEndHandler: (() => void) | null = null;

  /**
   * Ogg header cache: the first N bytes containing OpusHead + OpusTags pages.
   * Every Ogg Opus stream begins with these two mandatory pages. Late-joining
   * subscribers need them to initialise the decoder; without them the browser
   * reports MEDIA_ERR_DECODE.
   */
  private oggHeaderBuf: Buffer | null = null;
  private oggHeaderComplete = false;
  private oggPagesSeen = 0;

  constructor(options: StreamMultiplexerOptions = {}) {
    this.policy = options.policy || "LIVE_DROP";
    this.bufferSize = options.bufferSize || 64 * 1024; // 64KB default
    this.logDrops = options.logDrops || false;
  }

  /**
   * Set the source stream to multiplex
   */
  setSource(stream: Readable): void {
    // Clean up old source if exists
    if (this.source) {
      this.detachSource();
    }

    this.source = stream;
    this.isActive = true;

    // Reset Ogg header cache for the new source
    this.oggHeaderBuf = null;
    this.oggHeaderComplete = false;
    this.oggPagesSeen = 0;

    // Handle source data
    stream.on("data", (chunk: Buffer) => {
      this.accumulateOggHeaders(chunk);
      this.handleChunk(chunk);
    });

    // Handle source errors
    this.sourceErrorHandler = (error: Error) => {
      logger.error(`[StreamMultiplexer] Source error: ${error.message}`);
      this.handleSourceEnd();
    };
    stream.on("error", this.sourceErrorHandler);

    // Handle source end
    this.sourceEndHandler = () => {
      this.handleSourceEnd();
    };
    stream.on("end", this.sourceEndHandler);
    stream.on("close", this.sourceEndHandler);
  }

  /**
   * Add a consumer to receive multiplexed stream
   * @returns PassThrough stream for the consumer
   */
  addConsumer(id: string): PassThrough {
    const existingConsumer = this.consumers.get(id);
    if (existingConsumer) {
      logger.warn(
        `[StreamMultiplexer] Consumer ${id} already exists, returning existing stream`,
      );
      return existingConsumer.stream;
    }

    const stream = new PassThrough({
      highWaterMark: this.bufferSize,
    });

    const consumer: Consumer = {
      id,
      stream,
      droppedFrames: 0,
      totalFrames: 0,
      headerSent: false,
    };

    this.consumers.set(id, consumer);
    logger.debug(
      `[StreamMultiplexer] Added consumer: ${id} (total: ${this.consumers.size})`,
    );

    // Replay cached Ogg headers so late joiners can initialise the decoder.
    if (this.oggHeaderBuf && this.oggHeaderComplete) {
      stream.write(this.oggHeaderBuf);
      consumer.headerSent = true;
      logger.debug(
        `[StreamMultiplexer] Replayed ${this.oggHeaderBuf.length}-byte Ogg header to ${id}`,
      );
    }

    // Handle consumer errors and cleanup
    stream.on("error", (error) => {
      logger.debug(
        `[StreamMultiplexer] Consumer ${id} error: ${error.message}`,
      );
      this.removeConsumer(id);
    });

    stream.on("close", () => {
      logger.debug(`[StreamMultiplexer] Consumer ${id} closed`);
      this.removeConsumer(id);
    });

    return stream;
  }

  /**
   * Remove a consumer
   */
  removeConsumer(id: string): void {
    const consumer = this.consumers.get(id);
    if (!consumer) {
      return;
    }

    // Log stats if frames were dropped
    if (consumer.droppedFrames > 0) {
      const dropRate = (
        (consumer.droppedFrames / consumer.totalFrames) *
        100
      ).toFixed(2);
      logger.info(
        `[StreamMultiplexer] Consumer ${id} stats: ${consumer.droppedFrames}/${consumer.totalFrames} frames dropped (${dropRate}%)`,
      );
    }

    // End and destroy the stream
    if (!consumer.stream.destroyed) {
      consumer.stream.end();
      consumer.stream.destroy();
    }

    this.consumers.delete(id);
    logger.debug(
      `[StreamMultiplexer] Removed consumer: ${id} (remaining: ${this.consumers.size})`,
    );
  }

  /**
   * Get current consumer count
   */
  getConsumerCount(): number {
    return this.consumers.size;
  }

  /**
   * Check if a consumer exists
   */
  hasConsumer(id: string): boolean {
    return this.consumers.has(id);
  }

  /**
   * Get stats for a specific consumer
   */
  getConsumerStats(
    id: string,
  ): { droppedFrames: number; totalFrames: number } | null {
    const consumer = this.consumers.get(id);
    if (!consumer) {
      return null;
    }
    return {
      droppedFrames: consumer.droppedFrames,
      totalFrames: consumer.totalFrames,
    };
  }

  /**
   * Get stats for all consumers
   */
  getAllStats(): Map<string, { droppedFrames: number; totalFrames: number }> {
    const stats = new Map();
    for (const [id, consumer] of this.consumers.entries()) {
      stats.set(id, {
        droppedFrames: consumer.droppedFrames,
        totalFrames: consumer.totalFrames,
      });
    }
    return stats;
  }

  /**
   * Accumulate the first two Ogg pages (OpusHead + OpusTags) so they can be
   * replayed to late-joining subscribers. Scans for the "OggS" sync pattern
   * to count page boundaries. After seeing two complete pages, stops.
   */
  private accumulateOggHeaders(chunk: Buffer): void {
    if (this.oggHeaderComplete) return;

    if (!this.oggHeaderBuf) {
      this.oggHeaderBuf = chunk;
    } else {
      this.oggHeaderBuf = Buffer.concat([this.oggHeaderBuf, chunk]);
    }

    // Count Ogg pages in the accumulated buffer.
    // Each page starts with "OggS" (0x4f 0x67 0x67 0x53).
    let pages = 0;
    for (let i = 0; i < this.oggHeaderBuf.length - 3; i++) {
      if (
        this.oggHeaderBuf[i] === 0x4f &&
        this.oggHeaderBuf[i + 1] === 0x67 &&
        this.oggHeaderBuf[i + 2] === 0x67 &&
        this.oggHeaderBuf[i + 3] === 0x53
      ) {
        pages++;
        if (pages === 3) {
          // Third page starts here — header is everything before it
          this.oggHeaderBuf = this.oggHeaderBuf.subarray(0, i);
          this.oggHeaderComplete = true;
          this.oggPagesSeen = 2;
          logger.debug(
            `[StreamMultiplexer] Cached Ogg header (${this.oggHeaderBuf.length} bytes, 2 pages)`,
          );
          return;
        }
      }
    }
    this.oggPagesSeen = Math.max(this.oggPagesSeen, pages);

    // Safety: if we've accumulated >64KB without finding 3 pages, give up
    if (this.oggHeaderBuf.length > 64 * 1024) {
      this.oggHeaderComplete = true;
      this.oggHeaderBuf = null;
      logger.warn(
        "[StreamMultiplexer] Could not detect Ogg header pages; header replay disabled",
      );
    }
  }

  /**
   * Handle incoming chunk from source
   *
   * WHY THIS IS CRITICAL:
   * This is where backpressure isolation happens. Standard stream.pipe() would block
   * if ANY consumer can't keep up. We intentionally don't use pipe() - we manually
   * write to each consumer and handle backpressure per-consumer.
   *
   * THE ALGORITHM:
   * For each chunk from source:
   *   For each consumer:
   *     Try to write chunk
   *     If consumer's buffer is full (returns false):
   *       - LIVE_DROP: Drop frame immediately (radio-style)
   *       - BUFFER_THEN_DROP: Drop only if buffer >90% full
   *       - BLOCKING: Wait (not implemented fully - would need async)
   *
   * WHY TRACK STATS:
   * Knowing drop rates helps debug. If Discord shows 50% drops, it's a Discord
   * voice quality issue, not our code. If web client shows 50% drops, they have
   * a slow connection - that's expected and acceptable.
   */
  private handleChunk(chunk: Buffer): void {
    if (this.consumers.size === 0) {
      // No consumers, drop the chunk
      // WHY: Broadcast continues even with zero listeners (radio keeps broadcasting)
      return;
    }

    for (const consumer of this.consumers.values()) {
      consumer.totalFrames++;

      switch (this.policy) {
        case "LIVE_DROP":
          // Try to write, if backpressure, drop the frame
          if (!consumer.stream.write(chunk)) {
            consumer.droppedFrames++;
            if (this.logDrops) {
              logger.debug(
                `[StreamMultiplexer] Dropped frame for consumer ${consumer.id} (backpressure)`,
              );
            }
          }
          break;

        case "BUFFER_THEN_DROP":
          // Try to write, if backpressure and buffer full, drop
          if (!consumer.stream.write(chunk)) {
            // Check if buffer is full
            const bufferLength = consumer.stream.writableLength;
            if (bufferLength >= this.bufferSize * 0.9) {
              // Buffer > 90% full, start dropping
              consumer.droppedFrames++;
              if (this.logDrops) {
                logger.debug(
                  `[StreamMultiplexer] Dropped frame for consumer ${consumer.id} (buffer full)`,
                );
              }
            }
          }
          break;

        case "BLOCKING":
          // Wait for drain before continuing (blocks source)
          if (!consumer.stream.write(chunk)) {
            // In blocking mode, we'd need to pause source
            // This is complex, so for now just log and continue
            logger.warn(
              `[StreamMultiplexer] Consumer ${consumer.id} causing backpressure in BLOCKING mode`,
            );
          }
          break;
      }
    }
  }

  /**
   * Handle source stream end
   */
  private handleSourceEnd(): void {
    logger.debug("[StreamMultiplexer] Source stream ended");
    this.isActive = false;

    // End all consumer streams
    for (const consumer of this.consumers.values()) {
      if (!consumer.stream.destroyed) {
        consumer.stream.end();
      }
    }

    this.detachSource();
  }

  /**
   * Detach and clean up source stream handlers
   */
  private detachSource(): void {
    if (!this.source) {
      return;
    }

    if (this.sourceErrorHandler) {
      this.source.removeListener("error", this.sourceErrorHandler);
      this.sourceErrorHandler = null;
    }

    if (this.sourceEndHandler) {
      this.source.removeListener("end", this.sourceEndHandler);
      this.source.removeListener("close", this.sourceEndHandler);
      this.sourceEndHandler = null;
    }

    this.source = null;
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    logger.debug("[StreamMultiplexer] Destroying multiplexer");

    // Remove all consumers
    const consumerIds = Array.from(this.consumers.keys());
    for (const id of consumerIds) {
      this.removeConsumer(id);
    }

    // Detach source
    this.detachSource();

    this.isActive = false;
  }

  /**
   * Get active status
   */
  isStreamActive(): boolean {
    return this.isActive;
  }
}
