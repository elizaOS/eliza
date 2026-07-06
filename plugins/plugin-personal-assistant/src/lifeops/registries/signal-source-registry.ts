/**
 * SignalSourceRegistry.
 *
 * The single extension point for passive activity-signal sources. Each source
 * contributes one entry carrying both halves of "how to interpret this source":
 * a `telemetryMapper` (persisted signal → canonical `LifeOpsTelemetryPayload`)
 * and a `reliability` weight resolver. Before this registry those two halves
 * lived in three coordinated places — the closed source union in
 * `@elizaos/shared`, the closed mapper switch in PA's `telemetry-mapping.ts`,
 * and the closed reliability table in `@elizaos/plugin-health` — so adding one
 * source (browser activity, view usage, reaction activity, …) meant edits
 * across three packages. A registration collapses that to one call.
 *
 * The source vocabulary is opened exactly as `LifeOpsBusFamily` opened
 * `LifeOpsTelemetryFamily`: the built-in eight keep their closed
 * `LifeOpsActivitySignalSource` discriminant (and typed payload schemas), while
 * `LifeOpsActivitySignalSourceName` admits any contributed source. Ingestion
 * (`normalizeActivitySignalSource`) validates against `registry.sources()`, and
 * the telemetry-mirror path dispatches through `registry.get(source)` instead
 * of a switch whose `default` silently dropped the row.
 *
 * Per-runtime, `WeakMap`-keyed like `FamilyRegistry` so lifetime tracks the
 * runtime and nothing leaks across tests.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsActivitySignal,
  LifeOpsActivitySignalSourceName,
  LifeOpsTelemetryPayload,
} from "@elizaos/shared";

export interface SignalSourceContribution {
  /** Open-string source identifier (built-in or contributed). */
  source: LifeOpsActivitySignalSourceName;
  /** Human-readable description for diagnostics + the planner. */
  description: string;
  /** Producer of this source: `"app-lifeops"`, `"plugin-browser"`, etc. */
  contributor: string;
  /**
   * Map a persisted signal into its canonical telemetry payload. Returns
   * `null` when *this signal instance* legitimately produces no telemetry row
   * (e.g. a `mobile_health` signal with no health payload) — that is not an
   * error. An *unregistered* source, by contrast, never reaches a mapper: the
   * mirror path reports it via `runtime.reportError`.
   */
  telemetryMapper: (
    signal: LifeOpsActivitySignal,
  ) => LifeOpsTelemetryPayload | null;
  /** Confidence weight in [0, 1] for a signal instance from this source. */
  reliability: (signal: LifeOpsActivitySignal) => number;
}

export interface SignalSourceRegistry {
  register(contribution: SignalSourceContribution): void;
  get(source: LifeOpsActivitySignalSourceName): SignalSourceContribution | null;
  has(source: LifeOpsActivitySignalSourceName): boolean;
  list(filter?: { contributor?: string }): SignalSourceContribution[];
  /** Every registered source name — the ingestion allow-list. */
  sources(): LifeOpsActivitySignalSourceName[];
}

class InMemorySignalSourceRegistry implements SignalSourceRegistry {
  private readonly bySource = new Map<
    LifeOpsActivitySignalSourceName,
    SignalSourceContribution
  >();

  register(contribution: SignalSourceContribution): void {
    if (!contribution.source) {
      throw new Error("SignalSourceRegistry.register: source is required");
    }
    if (this.bySource.has(contribution.source)) {
      throw new Error(
        `SignalSourceRegistry.register: source "${contribution.source}" already registered`,
      );
    }
    this.bySource.set(contribution.source, contribution);
  }

  get(
    source: LifeOpsActivitySignalSourceName,
  ): SignalSourceContribution | null {
    return this.bySource.get(source) ?? null;
  }

  has(source: LifeOpsActivitySignalSourceName): boolean {
    return this.bySource.has(source);
  }

  list(filter?: { contributor?: string }): SignalSourceContribution[] {
    const all = Array.from(this.bySource.values());
    if (!filter?.contributor) return all;
    return all.filter((c) => c.contributor === filter.contributor);
  }

  sources(): LifeOpsActivitySignalSourceName[] {
    return Array.from(this.bySource.keys());
  }
}

export function createSignalSourceRegistry(): SignalSourceRegistry {
  return new InMemorySignalSourceRegistry();
}

const registries = new WeakMap<IAgentRuntime, SignalSourceRegistry>();

export function registerSignalSourceRegistry(
  runtime: IAgentRuntime,
  registry: SignalSourceRegistry,
): void {
  registries.set(runtime, registry);
}

export function getSignalSourceRegistry(
  runtime: IAgentRuntime,
): SignalSourceRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetSignalSourceRegistryForTests(
  runtime: IAgentRuntime,
): void {
  registries.delete(runtime);
}
