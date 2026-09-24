/**
 * Trace helpers for the PR #15931-compatible voice timing schema.
 *
 * Each benchmark turn carries an `X-Eliza-Voice-Trace-Id` value and a
 * `Server-Timing`-style component list so local runs can be compared with the
 * production voice route instrumentation without depending on those routes.
 */

import type {
  CheckpointName,
  ServerTimingComponent,
  TraceCheckpoint,
} from "./types.ts";

export class TraceBuilder {
  readonly traceId: string;
  readonly checkpoints: TraceCheckpoint[] = [];
  readonly serverTiming: ServerTimingComponent[] = [];

  constructor(traceId: string) {
    this.traceId = traceId;
  }

  mark(name: CheckpointName, atMs: number, provider?: string): void {
    this.checkpoints.push({ name, atMs, provider });
  }

  timing(name: string, durMs: number, desc?: string): void {
    this.serverTiming.push({ name, durMs, desc });
  }

  at(name: CheckpointName): number | null {
    const checkpoint = this.checkpoints.find((entry) => entry.name === name);
    return checkpoint ? checkpoint.atMs : null;
  }
}

export function makeTraceId(caseId: string, runIndex: number): string {
  return `voice-rtt-${caseId}-${runIndex}-${Date.now().toString(36)}`;
}

export function formatServerTiming(
  components: readonly ServerTimingComponent[],
): string {
  return components
    .map((component) => {
      const dur = `dur=${Math.round(component.durMs * 1000) / 1000}`;
      return component.desc
        ? `${component.name};${dur};desc="${component.desc.replaceAll('"', "'")}"`
        : `${component.name};${dur}`;
    })
    .join(", ");
}
