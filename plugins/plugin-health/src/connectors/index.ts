/**
 * Connector / anchor / bus-family registration entry point.
 *
 * Per `wave1-interfaces.md` §5.1 / §5.2 / §5.3, plugin-health contributes:
 *
 *   - 6 ConnectorContributions: apple_health, google_fit, strava, fitbit,
 *     withings, oura
 *   - 4 anchors: wake.observed, wake.confirmed, bedtime.target, nap.start
 *   - 8 bus families: health.sleep.detected, health.sleep.ended,
 *     health.wake.observed, health.wake.confirmed, health.nap.detected,
 *     health.bedtime.imminent, health.regularity.changed,
 *     health.workout.completed
 *
 * Registration is best-effort: if W1-A / W1-F's runtime registries have not
 * landed yet, this module logs a one-line skip and continues. The connector
 * / anchor / bus-family identifiers are still exported as constants so
 * other Wave-1 agents can reference them.
 */

import { logger } from "@elizaos/core";
import { getHealthProviderSpec } from "../health-bridge/health-provider-registry.js";
import { getLocalDateKey, getZonedDateParts } from "../util/time.js";
import type {
  ActivitySignalReader,
  AnchorContribution,
  AnchorRegistry,
  BusFamilyContribution,
  BusFamilyRegistry,
  ConnectorContribution,
  ConnectorOAuthConfig,
  ConnectorRegistry,
  ConnectorStatus,
  DispatchResult,
  RuntimeWithHealthRegistries,
} from "./contract-types.js";

export * from "./contract-types.js";

type RuntimeHealthRegistryHost = object & RuntimeWithHealthRegistries;

export const HEALTH_CONNECTOR_KINDS = [
  "apple_health",
  "google_fit",
  "strava",
  "fitbit",
  "withings",
  "oura",
] as const satisfies readonly string[];

export const HEALTH_ANCHORS = [
  "wake.observed",
  "wake.confirmed",
  "bedtime.target",
  "nap.start",
] as const satisfies readonly string[];

export const HEALTH_BUS_FAMILIES = [
  "health.sleep.detected",
  "health.sleep.ended",
  "health.wake.observed",
  "health.wake.confirmed",
  "health.nap.detected",
  "health.bedtime.imminent",
  "health.regularity.changed",
  "health.workout.completed",
] as const satisfies readonly string[];

/**
 * Capability strings published by plugin-health connectors. Matches the
 * `LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES` set in `../contracts/health.js` so a
 * planner querying `connectorRegistry.byCapability("health.sleep.read")`
 * resolves the correct contributors.
 */
const HEALTH_CONNECTOR_CAPABILITIES: Record<
  (typeof HEALTH_CONNECTOR_KINDS)[number],
  readonly string[]
> = {
  apple_health: [
    "health.sleep.read",
    "health.activity.read",
    "health.workouts.read",
    "health.body.read",
    "health.vitals.read",
  ],
  google_fit: [
    "health.sleep.read",
    "health.activity.read",
    "health.workouts.read",
    "health.body.read",
    "health.vitals.read",
  ],
  strava: ["health.activity.read", "health.workouts.read"],
  fitbit: [
    "health.sleep.read",
    "health.activity.read",
    "health.workouts.read",
    "health.body.read",
    "health.vitals.read",
    "health.readiness.read",
  ],
  withings: ["health.sleep.read", "health.body.read", "health.vitals.read"],
  oura: [
    "health.sleep.read",
    "health.activity.read",
    "health.workouts.read",
    "health.readiness.read",
  ],
};

const CONNECTOR_LABELS: Record<
  (typeof HEALTH_CONNECTOR_KINDS)[number],
  string
> = {
  apple_health: "Apple Health (HealthKit)",
  google_fit: "Google Fit",
  strava: "Strava",
  fitbit: "Fitbit",
  withings: "Withings",
  oura: "Oura",
};

/**
 * Wave-1 registry adapter. The actual `start` / `verify` / `status` /
 * `read` implementations live in `health-bridge.ts` + `health-connectors.ts`
 * and require a fully-wired runtime context (credentials store, OAuth
 * sessions, repository factory) that the W1-F generic ConnectorRegistry
 * hasn't standardised yet.
 *
 * Until W1-F publishes the runtime context shape, the contribution emits
 * `disconnected` for status checks and `transport_error` for send/read so
 * downstream task scheduling treats the connector as unavailable rather
 * than silently succeeding.
 */
function buildConnectorContribution(
  kind: (typeof HEALTH_CONNECTOR_KINDS)[number],
): ConnectorContribution {
  const unavailableStatus = async (): Promise<ConnectorStatus> => ({
    state: "disconnected",
    message:
      "plugin-health Wave-1 connector is unavailable until W1-F's runtime context shape is finalised.",
    observedAt: new Date().toISOString(),
  });
  const unavailableSend = async (): Promise<DispatchResult> => ({
    ok: false,
    reason: "transport_error",
    userActionable: true,
    message:
      "plugin-health Wave-1 connector send is unavailable; configure via the legacy lifeops health-connectors path.",
  });
  // URL provided by the connector contribution; the dispatcher does not
  // hardcode. The OAuth-bridged providers (strava / fitbit / withings / oura)
  // surface their authorize / token / api-base URLs from the canonical
  // health-provider registry.
  const providerSpec = getHealthProviderSpec(kind);
  const oauth: ConnectorOAuthConfig | undefined = providerSpec
    ? {
        authorizeUrl: providerSpec.oauth.authorizeUrl,
        tokenUrl: providerSpec.oauth.tokenUrl,
        revokeUrl: providerSpec.oauth.revokeUrl,
        scopes: providerSpec.oauth.defaultScopes,
      }
    : undefined;
  const apiBaseUrl = providerSpec?.apiBaseUrl;
  return {
    kind,
    capabilities: [...HEALTH_CONNECTOR_CAPABILITIES[kind]],
    modes:
      kind === "apple_health"
        ? ["local"]
        : kind === "google_fit"
          ? ["local", "cloud"]
          : ["cloud"],
    describe: { label: CONNECTOR_LABELS[kind] },
    oauth,
    apiBaseUrl,
    start: async () => {
      // Wave-1 registry adapter — concrete start lives in `health-bridge.ts` /
      // `health-connectors.ts` and is invoked through the legacy
      // app-lifeops mixin path until W1-F's generic dispatcher lands.
    },
    disconnect: async () => {
      // Wave-1 registry adapter — concrete disconnect lives in `health-oauth.ts`.
    },
    verify: async () => false,
    status: unavailableStatus,
    send: unavailableSend,
    read: async () => null,
  };
}

/**
 * Where each health anchor reads its observation from, and how freshness is
 * judged. `observation` anchors point at a transition that already happened
 * (a wake or nap edge); `target` anchors point at a resolved future/near
 * instant (the bedtime target carried on the `health.bedtime.imminent`
 * edge, whose `occurredAt` IS the target instant).
 */
const OBSERVED_ANCHOR_SOURCES: Record<
  (typeof HEALTH_ANCHORS)[number],
  {
    family: (typeof HEALTH_BUS_FAMILIES)[number];
    semantics: "observation" | "target";
  }
> = {
  "wake.observed": {
    family: "health.wake.observed",
    semantics: "observation",
  },
  "wake.confirmed": {
    family: "health.wake.confirmed",
    semantics: "observation",
  },
  "bedtime.target": {
    family: "health.bedtime.imminent",
    semantics: "target",
  },
  "nap.start": { family: "health.nap.detected", semantics: "observation" },
};

/**
 * Bus read window. Wider than any freshness rule below so the rules — not
 * the query bound — decide staleness; the bus itself retains only 24h.
 */
const ANCHOR_SIGNAL_QUERY_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/** Clock-skew tolerance for "an observation must not be in the future". */
const OBSERVATION_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Freshness bound for `target`-semantics anchors: a bedtime target is usable
 * from 12h before to 12h after the instant it names. Beyond that the static
 * `eveningWindow.end` default is more trustworthy than the stale target.
 */
const TARGET_FRESHNESS_MS = 12 * 60 * 60 * 1000;

/**
 * Local calendar-day key for an instant, degrading to UTC when the
 * owner-fact timezone is not a valid IANA id.
 */
function localDayKey(ms: number, timeZone: string): string | null {
  try {
    return getLocalDateKey(getZonedDateParts(new Date(ms), timeZone));
  } catch (error) {
    // error-policy:J3 — ownerFacts.timezone is owner-supplied input; an
    // invalid IANA id degrades the same-local-day comparison to UTC instead
    // of throwing out of the scheduler tick that calls resolve().
    if (timeZone === "UTC") {
      logger.warn(
        { src: "plugin:health", error },
        "Anchor freshness day-key computation failed even in UTC",
      );
      return null;
    }
    return localDayKey(ms, "UTC");
  }
}

function anchorTimezone(ownerFacts: unknown): string {
  if (
    typeof ownerFacts === "object" &&
    ownerFacts !== null &&
    "timezone" in ownerFacts &&
    typeof (ownerFacts as { timezone?: unknown }).timezone === "string" &&
    (ownerFacts as { timezone: string }).timezone.length > 0
  ) {
    return (ownerFacts as { timezone: string }).timezone;
  }
  return "UTC";
}

/**
 * Observed-anchor resolver (#12284 WI-1). Reads the most recent transition
 * envelope for the anchor's bus family and returns its instant, so
 * `relative_to_anchor("wake.confirmed", offset)` anchors to the ACTUAL
 * observed wake instead of the configured morning window.
 *
 * Freshness rules (documented for the tests that pin them):
 *   - `observation` anchors (wake.observed / wake.confirmed / nap.start):
 *     the transition must have occurred on the SAME local calendar day as
 *     `nowIso` in the owner's timezone, and not in the future beyond clock
 *     skew. Same-local-day is deliberately tighter than the issue's 24-48h
 *     staleness bound: after local midnight yesterday's wake must never
 *     anchor today's schedule.
 *   - `target` anchors (bedtime.target): usable within ±12h of now.
 *
 * Returning `null` is the designed degrade — the spine's `nextAnchorIso` /
 * `resolveAnchorIso` fall through to the static owner-window defaults
 * (`morningWindow.start`, `eveningWindow.end`/22:30). resolve() never
 * throws: a broken reader must not break the scheduler tick.
 */
function buildAnchorContribution(
  anchorKey: (typeof HEALTH_ANCHORS)[number],
  readSignals: () => ActivitySignalReader | null,
): AnchorContribution {
  const signalSource = OBSERVED_ANCHOR_SOURCES[anchorKey];
  return {
    anchorKey,
    description: `plugin-health anchor: ${anchorKey}`,
    source: "plugin-health",
    describe: {
      label: `plugin-health anchor: ${anchorKey}`,
      provider: "plugin-health",
    },
    resolve: async (context: unknown): Promise<{ atIso: string } | null> => {
      const nowIso =
        typeof context === "object" &&
        context !== null &&
        "nowIso" in context &&
        typeof (context as { nowIso?: unknown }).nowIso === "string"
          ? (context as { nowIso: string }).nowIso
          : null;
      const nowMs = nowIso === null ? Number.NaN : Date.parse(nowIso);
      if (!Number.isFinite(nowMs)) return null;

      let latestMs: number | null = null;
      try {
        const reader = readSignals();
        if (!reader) return null;
        const envelopes = reader.recent({
          sinceIso: new Date(
            nowMs - ANCHOR_SIGNAL_QUERY_LOOKBACK_MS,
          ).toISOString(),
          family: signalSource.family,
        });
        for (const envelope of envelopes) {
          // Defensive family re-check: readers are only obligated to treat
          // `family` as a filter hint, and a mixed result must not let a
          // sleep edge masquerade as a wake anchor.
          if (envelope.family !== signalSource.family) continue;
          const occurredMs = Date.parse(envelope.occurredAt);
          if (!Number.isFinite(occurredMs)) continue;
          if (latestMs === null || occurredMs > latestMs) {
            latestMs = occurredMs;
          }
        }
      } catch (error) {
        // error-policy:J4 — anchor resolution is a designed degrade: a
        // failed signal read falls back to the static owner-window default
        // instead of breaking the scheduler tick. The warn keeps the
        // failure observable.
        logger.warn(
          { src: "plugin:health", anchorKey, error },
          "Observed-anchor signal read failed; falling back to static anchor default",
        );
        return null;
      }
      if (latestMs === null) return null;

      if (signalSource.semantics === "target") {
        if (Math.abs(latestMs - nowMs) > TARGET_FRESHNESS_MS) return null;
      } else {
        if (latestMs > nowMs + OBSERVATION_FUTURE_SKEW_MS) return null;
        const timeZone = anchorTimezone(
          (context as { ownerFacts?: unknown }).ownerFacts,
        );
        const observedDay = localDayKey(latestMs, timeZone);
        const currentDay = localDayKey(nowMs, timeZone);
        if (
          observedDay === null ||
          currentDay === null ||
          observedDay !== currentDay
        ) {
          return null;
        }
      }
      return { atIso: new Date(latestMs).toISOString() };
    },
  };
}

function buildBusFamilyContribution(family: string): BusFamilyContribution {
  return {
    family,
    description: `plugin-health bus family: ${family}`,
    source: "plugin-health",
  };
}

function getConnectorRegistry(
  runtime: RuntimeHealthRegistryHost,
): ConnectorRegistry | undefined {
  return runtime.connectorRegistry;
}

function getAnchorRegistry(
  runtime: RuntimeHealthRegistryHost,
): AnchorRegistry | undefined {
  return runtime.anchorRegistry;
}

function getBusFamilyRegistry(
  runtime: RuntimeHealthRegistryHost,
): BusFamilyRegistry | undefined {
  return runtime.busFamilyRegistry;
}

export function registerHealthConnectors(
  runtime: RuntimeHealthRegistryHost,
): void {
  const registry = getConnectorRegistry(runtime);
  if (!registry) {
    logger.info(
      { src: "plugin:health", waiting_on: "W1-F connectorRegistry" },
      "Skipping plugin-health connector registration (registry unavailable)",
    );
    return;
  }
  for (const kind of HEALTH_CONNECTOR_KINDS) {
    if (registry.get(kind)) {
      continue;
    }
    registry.register(buildConnectorContribution(kind));
  }
  logger.info(
    {
      src: "plugin:health",
      registered: HEALTH_CONNECTOR_KINDS.length,
      kinds: HEALTH_CONNECTOR_KINDS,
    },
    "Registered plugin-health connectors",
  );
}

export function registerHealthAnchors(
  runtime: RuntimeHealthRegistryHost,
): void {
  const registry = getAnchorRegistry(runtime);
  if (!registry) {
    logger.info(
      { src: "plugin:health", waiting_on: "W1-A anchorRegistry" },
      "Skipping plugin-health anchor registration (registry unavailable)",
    );
    return;
  }
  // Late-bound reader: the host may attach its ActivitySignalBus after the
  // anchors register (boot-order tolerance, same posture as the registries
  // themselves). resolve() re-reads the runtime property on every call.
  const readSignals = (): ActivitySignalReader | null =>
    runtime.activitySignalBus ?? null;
  for (const anchorKey of HEALTH_ANCHORS) {
    if (registry.get(anchorKey)) {
      continue;
    }
    registry.register(buildAnchorContribution(anchorKey, readSignals));
  }
  logger.info(
    {
      src: "plugin:health",
      registered: HEALTH_ANCHORS.length,
      anchors: HEALTH_ANCHORS,
    },
    "Registered plugin-health anchors",
  );
}

export function registerHealthBusFamilies(
  runtime: RuntimeHealthRegistryHost,
): void {
  const registry = getBusFamilyRegistry(runtime);
  if (!registry) {
    logger.info(
      { src: "plugin:health", waiting_on: "W1-A or W2-D busFamilyRegistry" },
      "Skipping plugin-health bus-family registration (registry unavailable)",
    );
    return;
  }
  for (const family of HEALTH_BUS_FAMILIES) {
    if (
      registry.list().some((contribution) => contribution.family === family)
    ) {
      continue;
    }
    registry.register(buildBusFamilyContribution(family));
  }
  logger.info(
    {
      src: "plugin:health",
      registered: HEALTH_BUS_FAMILIES.length,
      families: HEALTH_BUS_FAMILIES,
    },
    "Registered plugin-health bus families",
  );
}
