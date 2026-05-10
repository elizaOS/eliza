/**
 * EventKindRegistry.
 *
 * `ScheduledTask.trigger.kind = "event"` carries an `eventKind: string` and
 * an opaque `filter: EventFilter`. The registry types each `eventKind` per
 * contribution: producers register `{ eventKind, filterSchema, describe }`
 * and the runner asks the registry to validate / parse the filter before
 * subscribing to bus events.
 *
 * The registry is per-runtime (mirrors `connectorRegistry`), validates
 * uniqueness, and deliberately keeps the `filterSchema` opaque (`unknown`)
 * so different producers can use different schema formats (JSON Schema,
 * Zod, or plain shape descriptors) without a forced common-schema
 * abstraction.
 */

import type { IAgentRuntime } from "@elizaos/core";

export interface EventKindContribution {
  /** Stable event-kind identifier — `"calendar.meeting.ended"`, `"health.wake.confirmed"`, etc. */
  eventKind: string;
  /**
   * Opaque schema descriptor for the trigger's `filter` payload. The runner
   * does not interpret the schema; downstream gate code consults the
   * registered contribution if it needs to validate filter shape.
   */
  filterSchema?: unknown;
  /** Human-readable diagnostics. */
  describe: { label: string; provider: string };
  /**
   * Optional payload-shape descriptor for the bus event itself (when
   * routed through `signals/bus.ts`). Unused by the runner; surfaced for
   * tooling.
   */
  payloadSchema?: unknown;
}

export interface EventKindRegistry {
  register(contribution: EventKindContribution): void;
  list(filter?: { provider?: string }): EventKindContribution[];
  get(eventKind: string): EventKindContribution | null;
  has(eventKind: string): boolean;
}

class InMemoryEventKindRegistry implements EventKindRegistry {
  private readonly byKind = new Map<string, EventKindContribution>();

  register(contribution: EventKindContribution): void {
    if (!contribution.eventKind) {
      throw new Error("EventKindRegistry.register: eventKind is required");
    }
    if (this.byKind.has(contribution.eventKind)) {
      throw new Error(
        `EventKindRegistry.register: eventKind "${contribution.eventKind}" already registered`,
      );
    }
    this.byKind.set(contribution.eventKind, contribution);
  }

  list(filter?: { provider?: string }): EventKindContribution[] {
    const all = Array.from(this.byKind.values());
    if (!filter?.provider) return all;
    return all.filter((c) => c.describe.provider === filter.provider);
  }

  get(eventKind: string): EventKindContribution | null {
    return this.byKind.get(eventKind) ?? null;
  }

  has(eventKind: string): boolean {
    return this.byKind.has(eventKind);
  }
}

export function createEventKindRegistry(): EventKindRegistry {
  return new InMemoryEventKindRegistry();
}

/**
 * Default app-lifeops event-kind contributions: calendar + time-window
 * events emitted by the calendar / anchor surfaces. plugin-health registers
 * its own `health.*` event kinds via its registration entry point.
 */
export const APP_LIFEOPS_EVENT_KINDS: readonly EventKindContribution[] = [
  {
    eventKind: "calendar.meeting.ended",
    describe: {
      label: "Calendar meeting end-edge",
      provider: "app-lifeops:calendar",
    },
  },
  {
    eventKind: "time.morning.start",
    describe: {
      label: "Owner morning window opened",
      provider: "app-lifeops:time-window",
    },
  },
  {
    eventKind: "time.lunch.start",
    describe: {
      label: "Owner lunch window opened",
      provider: "app-lifeops:time-window",
    },
  },
  {
    eventKind: "time.night.start",
    describe: {
      label: "Owner evening / wind-down window opened",
      provider: "app-lifeops:time-window",
    },
  },
];

export function registerAppLifeOpsEventKinds(
  registry: EventKindRegistry,
): void {
  for (const contribution of APP_LIFEOPS_EVENT_KINDS) {
    registry.register(contribution);
  }
}

const registries = new WeakMap<IAgentRuntime, EventKindRegistry>();

export function registerEventKindRegistry(
  runtime: IAgentRuntime,
  registry: EventKindRegistry,
): void {
  registries.set(runtime, registry);
}

export function getEventKindRegistry(
  runtime: IAgentRuntime,
): EventKindRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetEventKindRegistryForTests(
  runtime: IAgentRuntime,
): void {
  registries.delete(runtime);
}
