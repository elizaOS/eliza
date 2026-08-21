/**
 * Selects deterministic fault steps at named external boundaries and exposes
 * typed failures that production-client adapters can translate into protocols.
 */
import type { FaultEffect, FaultScript } from "./manifest.ts";

export class SyntheticFaultError extends Error {
  public constructor(
    public readonly boundary: string,
    public readonly attempt: number,
    public readonly effect: FaultEffect,
  ) {
    super(`Synthetic fault ${effect.kind} at ${boundary} attempt ${attempt}`);
    this.name = "SyntheticFaultError";
  }
}

export class FaultController {
  private readonly attempts = new Map<string, number>();
  private readonly scriptsByBoundary: ReadonlyMap<string, FaultScript>;

  public constructor(scripts: readonly FaultScript[]) {
    const grouped = new Map<string, FaultScript>();
    for (const script of scripts) {
      if (grouped.has(script.boundary)) {
        throw new Error(
          `Only one fault script may target boundary ${script.boundary}`,
        );
      }
      const attempts = new Set<number>();
      for (const step of script.steps) {
        if (attempts.has(step.onAttempt)) {
          throw new Error(
            `Fault script ${script.id} repeats attempt ${step.onAttempt}`,
          );
        }
        attempts.add(step.onAttempt);
      }
      grouped.set(script.boundary, script);
    }
    this.scriptsByBoundary = grouped;
  }

  public next(boundary: string): {
    readonly attempt: number;
    readonly effect?: FaultEffect;
  } {
    const attempt = (this.attempts.get(boundary) ?? 0) + 1;
    this.attempts.set(boundary, attempt);
    const effect = this.scriptsByBoundary
      .get(boundary)
      ?.steps.find((step) => step.onAttempt === attempt)?.effect;
    return { attempt, effect };
  }

  public reset(): void {
    this.attempts.clear();
  }

  public snapshot(): readonly {
    readonly boundary: string;
    readonly attempts: number;
  }[] {
    return [...this.attempts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([boundary, attempts]) => ({ boundary, attempts }));
  }
}
