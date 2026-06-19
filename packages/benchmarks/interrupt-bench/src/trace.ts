/**
 * Trace — append-only event log per scenario run.
 *
 * Captures every observable in the harness: messages in, handler start/end,
 * Stage-1 calls, planner calls, abort signals, preempts, thread ops, replies
 * emitted, and boundary violations. The scorer reads this trace to compute
 * the trace / boundary axes; the markdown report renders it for humans.
 *
 * Append-only; no mutation after `seal()` is called.
 */

import type { TraceEvent, TraceEventType } from "./types.ts";

export class Trace {
  private events: TraceEvent[] = [];
  private sealed = false;

  constructor(private readonly getVirtualNow: () => number) {}

  push(
    type: TraceEventType,
    extras: Omit<TraceEvent, "t" | "type"> = {},
  ): void {
    if (this.sealed) return;
    this.events.push({
      t: this.getVirtualNow(),
      type,
      ...extras,
    });
  }

  seal(): void {
    this.sealed = true;
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }

  count(type: TraceEventType): number {
    return this.events.reduce((n, e) => (e.type === type ? n + 1 : n), 0);
  }

  countWhere(predicate: (e: TraceEvent) => boolean): number {
    return this.events.reduce((n, e) => (predicate(e) ? n + 1 : n), 0);
  }

  find(predicate: (e: TraceEvent) => boolean): TraceEvent | undefined {
    return this.events.find(predicate);
  }

  filter(predicate: (e: TraceEvent) => boolean): TraceEvent[] {
    return this.events.filter(predicate);
  }
}
