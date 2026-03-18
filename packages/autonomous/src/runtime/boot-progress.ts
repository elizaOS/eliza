/**
 * Boot progress event system for reporting startup phase progression.
 *
 * Used by the TUI loading screen to show animated progress during
 * the elizaOS runtime boot sequence.
 *
 * @module boot-progress
 */
import { EventEmitter } from "node:events";

/** Definition of a single boot phase with its display label and weight. */
export interface BootPhaseDefinition {
  readonly id: string;
  readonly label: string;
  /** Fraction of total progress this phase represents (0–1, all sum to 1). */
  readonly weight: number;
}

/**
 * Ordered list of boot phases with their relative weights.
 * Weights sum to 1.0 and represent the approximate time share of each phase.
 */
export const BOOT_PHASES = [
  { id: "config", label: "Loading configuration", weight: 0.05 },
  { id: "plugins", label: "Resolving plugins", weight: 0.15 },
  { id: "database", label: "Initializing database", weight: 0.15 },
  { id: "embeddings", label: "Loading embedding model", weight: 0.25 },
  { id: "runtime", label: "Starting runtime", weight: 0.2 },
  { id: "skills", label: "Loading skills", weight: 0.15 },
  { id: "ready", label: "Ready!", weight: 0.05 },
] as const satisfies readonly BootPhaseDefinition[];

/** Valid boot phase identifiers. */
export type BootPhaseId = (typeof BOOT_PHASES)[number]["id"];

/** Payload emitted on the "progress" event. */
export interface BootProgressEvent {
  /** Current phase identifier. */
  phase: BootPhaseId;
  /** Human-readable label for the current phase. */
  label: string;
  /** Overall progress from 0 to 1. */
  progress: number;
  /** Optional sub-detail (e.g. "downloading gguf-v3-Q4_K_M…"). */
  detail?: string;
}

/**
 * Event emitter that tracks boot phase progression and emits typed
 * "progress" events for UI consumers (e.g. the loading screen).
 *
 * @example
 * ```ts
 * const reporter = new BootProgressReporter();
 * reporter.on("progress", (event) => {
 *   console.log(`${event.label} — ${Math.round(event.progress * 100)}%`);
 * });
 * reporter.phase("config");
 * reporter.phase("plugins");
 * reporter.complete();
 * ```
 */
export class BootProgressReporter extends EventEmitter {
  /**
   * Signal entry into a boot phase.
   *
   * Progress is calculated as the sum of weights of all phases
   * *before* the current one (i.e. the current phase is "in progress").
   */
  phase(id: BootPhaseId, detail?: string): void {
    const phaseIdx = BOOT_PHASES.findIndex((p) => p.id === id);
    if (phaseIdx < 0) return;

    const completedWeight = BOOT_PHASES.slice(0, phaseIdx).reduce(
      (sum, p) => sum + p.weight,
      0,
    );

    const phase = BOOT_PHASES[phaseIdx];
    this.emit("progress", {
      phase: id,
      label: phase.label,
      progress: completedWeight,
      detail,
    } satisfies BootProgressEvent);
  }

  /** Signal that boot is complete (progress = 1). */
  complete(): void {
    this.emit("progress", {
      phase: "ready",
      label: "Ready!",
      progress: 1,
    } satisfies BootProgressEvent);
  }
}
