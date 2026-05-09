/**
 * W2-D — FamilyRegistry.
 *
 * Lifts the closed `LIFEOPS_TELEMETRY_FAMILIES` discriminated union into an
 * open registry of namespaced bus-family identifiers. The closed union still
 * encodes the canonical telemetry payload schemas in
 * `packages/shared/src/contracts/lifeops.ts` for the built-in 11 families;
 * the registry tracks every family that flows through the activity-signal
 * bus, including new namespaced contributions like `health.sleep.detected`,
 * `calendar.meeting.ended`, etc.
 *
 * Family-name convention:
 *   - built-ins: lower-snake-case (`device_presence_event`, `manual_override_event`).
 *   - namespaced contributions: dotted, lower-case (`health.sleep.detected`,
 *     `calendar.meeting.ended`, `time.morning.start`).
 *
 * The registry is per-runtime and validates membership at runtime; producers
 * push events through `ActivitySignalBus` (see `signals/bus.ts`) which
 * consults the registry.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  LIFEOPS_TELEMETRY_FAMILIES,
  type LifeOpsBusFamily,
  type LifeOpsTelemetryFamily,
} from "@elizaos/shared";

export interface BusFamilyContribution {
  /** Open-string family identifier (built-in or namespaced). */
  family: LifeOpsBusFamily;
  /** Human-readable description for diagnostics + the planner. */
  description: string;
  /**
   * Producer of this family. `"plugin-health"`, `"app-lifeops"`,
   * `"plugin-calendar"`, etc. Free-form because new plugins can register.
   */
  source: string;
  /**
   * Optional namespace prefix (e.g. `"health"`, `"calendar"`, `"time"`). When
   * absent, the family is a built-in `LifeOpsTelemetryFamily`.
   */
  namespace?: string;
}

export interface FamilyRegistry {
  register(contribution: BusFamilyContribution): void;
  list(filter?: { namespace?: string; source?: string }): BusFamilyContribution[];
  get(family: LifeOpsBusFamily): BusFamilyContribution | null;
  has(family: LifeOpsBusFamily): boolean;
  /**
   * `true` when the family is the closed `LifeOpsTelemetryFamily` union from
   * the shared contracts (i.e. it carries a typed payload schema). Used by
   * the bus layer to decide whether to validate the payload shape.
   */
  isBuiltin(family: LifeOpsBusFamily): family is LifeOpsTelemetryFamily;
}

class InMemoryFamilyRegistry implements FamilyRegistry {
  private readonly byFamily = new Map<LifeOpsBusFamily, BusFamilyContribution>();

  register(contribution: BusFamilyContribution): void {
    if (!contribution.family) {
      throw new Error("FamilyRegistry.register: family is required");
    }
    if (this.byFamily.has(contribution.family)) {
      throw new Error(
        `FamilyRegistry.register: family "${contribution.family}" already registered`,
      );
    }
    this.byFamily.set(contribution.family, contribution);
  }

  list(filter?: {
    namespace?: string;
    source?: string;
  }): BusFamilyContribution[] {
    const all = Array.from(this.byFamily.values());
    if (!filter) return all;
    return all.filter((c) => {
      if (filter.namespace && c.namespace !== filter.namespace) return false;
      if (filter.source && c.source !== filter.source) return false;
      return true;
    });
  }

  get(family: LifeOpsBusFamily): BusFamilyContribution | null {
    return this.byFamily.get(family) ?? null;
  }

  has(family: LifeOpsBusFamily): boolean {
    return this.byFamily.has(family);
  }

  isBuiltin(family: LifeOpsBusFamily): family is LifeOpsTelemetryFamily {
    return (LIFEOPS_TELEMETRY_FAMILIES as readonly string[]).includes(family);
  }
}

export function createFamilyRegistry(): FamilyRegistry {
  return new InMemoryFamilyRegistry();
}

/**
 * Register the 11 built-in `LIFEOPS_TELEMETRY_FAMILIES` so callers can rely
 * on `registry.has(family)` for any family carried in
 * `LifeOpsTelemetryEnvelope`.
 */
export function registerBuiltinTelemetryFamilies(registry: FamilyRegistry): void {
  for (const family of LIFEOPS_TELEMETRY_FAMILIES) {
    registry.register({
      family,
      description: `LifeOps built-in telemetry family: ${family}`,
      source: "app-lifeops",
    });
  }
}

/**
 * App-lifeops contributes the calendar / time-window namespaced families
 * surfaced by the W2-C calendar decomposition (`meeting.ended`) and the
 * existing time-of-day windows (`morning.start`, `lunch.start`,
 * `night.start`). plugin-health contributes its `health.*` families through
 * its own registration entry point.
 */
export const APP_LIFEOPS_BUS_FAMILIES: readonly BusFamilyContribution[] = [
  {
    family: "calendar.meeting.ended",
    description:
      "Calendar event end-edge — emitted when a calendar meeting transitions from in-progress to completed.",
    source: "app-lifeops",
    namespace: "calendar",
  },
  {
    family: "time.morning.start",
    description:
      "Local-time anchor: owner's configured morning window has just started.",
    source: "app-lifeops",
    namespace: "time",
  },
  {
    family: "time.lunch.start",
    description:
      "Local-time anchor: owner's configured lunch window has just started.",
    source: "app-lifeops",
    namespace: "time",
  },
  {
    family: "time.night.start",
    description:
      "Local-time anchor: owner's configured evening / wind-down window has just started.",
    source: "app-lifeops",
    namespace: "time",
  },
];

export function registerAppLifeOpsBusFamilies(registry: FamilyRegistry): void {
  for (const contribution of APP_LIFEOPS_BUS_FAMILIES) {
    registry.register(contribution);
  }
}

/**
 * Per-runtime registry registration. Mirrors `connectorRegistry` /
 * `channelRegistry` — `WeakMap` keyed by runtime so the lifetime tracks the
 * runtime and we don't leak across tests.
 */
const registries = new WeakMap<IAgentRuntime, FamilyRegistry>();

export function registerFamilyRegistry(
  runtime: IAgentRuntime,
  registry: FamilyRegistry,
): void {
  registries.set(runtime, registry);
}

export function getFamilyRegistry(
  runtime: IAgentRuntime,
): FamilyRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetFamilyRegistryForTests(runtime: IAgentRuntime): void {
  registries.delete(runtime);
}
