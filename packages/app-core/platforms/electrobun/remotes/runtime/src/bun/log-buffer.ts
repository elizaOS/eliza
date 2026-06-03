import type { RuntimeLogEntry, RuntimeLogStream } from "./protocol.ts";

export class RuntimeLogBuffer {
  private readonly maxEntries: number;
  private entries: RuntimeLogEntry[] = [];

  constructor(maxEntries = 1000) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  push(stream: RuntimeLogStream, line: string): RuntimeLogEntry {
    const entry = {
      timestamp: new Date().toISOString(),
      stream,
      line,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }
    return entry;
  }

  tail(limit?: number): RuntimeLogEntry[] {
    if (limit === undefined) return [...this.entries];
    const normalized = Math.max(0, Math.floor(limit));
    return this.entries.slice(Math.max(0, this.entries.length - normalized));
  }

  clear(): void {
    this.entries = [];
  }
}
