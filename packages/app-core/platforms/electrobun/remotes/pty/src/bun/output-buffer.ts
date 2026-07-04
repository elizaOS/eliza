/** Implements Electrobun PTY remote output buffer ts boundaries for desktop app-core. */
import type {
  PtyOutputEntry,
  PtyOutputTailResult,
  PtySessionId,
} from "./protocol.ts";

export type PtyOutputLimits = {
  maxEntries: number;
  maxBytes: number;
};

type SessionBuffer = {
  entries: PtyOutputEntry[];
  nextSequence: number;
  totalBytes: number;
};

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class PtyOutputBuffer {
  readonly limits: PtyOutputLimits;
  private readonly buffers = new Map<PtySessionId, SessionBuffer>();

  constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    this.limits = {
      maxEntries: parsePositiveInt(
        env.ELIZA_PTY_MAX_OUTPUT_ENTRIES,
        DEFAULT_MAX_ENTRIES,
      ),
      maxBytes: parsePositiveInt(
        env.ELIZA_PTY_MAX_OUTPUT_BYTES,
        DEFAULT_MAX_BYTES,
      ),
    };
  }

  push(sessionId: PtySessionId, data: string): PtyOutputEntry {
    const buffer = this.getOrCreate(sessionId);
    const entry = {
      sessionId,
      sequence: buffer.nextSequence,
      data,
      timestamp: new Date().toISOString(),
    };
    buffer.nextSequence += 1;
    buffer.entries.push(entry);
    buffer.totalBytes += Buffer.byteLength(data, "utf8");
    this.trim(buffer);
    return entry;
  }

  tail(
    sessionId: PtySessionId,
    afterSequence?: number,
    limit?: number,
  ): PtyOutputTailResult {
    const buffer = this.getOrCreate(sessionId);
    const effectiveLimit = clampLimit(limit, 200, this.limits.maxEntries);
    const entries =
      afterSequence === undefined
        ? buffer.entries.slice(-effectiveLimit)
        : buffer.entries
            .filter((entry) => entry.sequence > afterSequence)
            .slice(-effectiveLimit);
    return {
      sessionId,
      entries,
      nextSequence: buffer.nextSequence,
    };
  }

  clear(sessionId: PtySessionId): void {
    this.buffers.set(sessionId, {
      entries: [],
      nextSequence: 0,
      totalBytes: 0,
    });
  }

  delete(sessionId: PtySessionId): void {
    this.buffers.delete(sessionId);
  }

  private getOrCreate(sessionId: PtySessionId): SessionBuffer {
    const existing = this.buffers.get(sessionId);
    if (existing) return existing;
    const created = {
      entries: [],
      nextSequence: 0,
      totalBytes: 0,
    };
    this.buffers.set(sessionId, created);
    return created;
  }

  private trim(buffer: SessionBuffer): void {
    while (buffer.entries.length > this.limits.maxEntries) {
      const removed = buffer.entries.shift();
      if (removed) buffer.totalBytes -= Buffer.byteLength(removed.data, "utf8");
    }
    while (
      buffer.totalBytes > this.limits.maxBytes &&
      buffer.entries.length > 0
    ) {
      const removed = buffer.entries.shift();
      if (removed) buffer.totalBytes -= Buffer.byteLength(removed.data, "utf8");
    }
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampLimit(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(Math.floor(value), maxValue);
}
