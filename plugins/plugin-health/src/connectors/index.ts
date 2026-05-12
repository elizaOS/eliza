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
import type {
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
} from "./contract-stubs.js";

export * from "./contract-stubs.js";

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
 * Wave-1 placeholder dispatcher. The actual `start` / `verify` / `status` /
 * `read` implementations live in `health-bridge.ts` + `health-connectors.ts`
 * and require a fully-wired runtime context (credentials store, OAuth
 * sessions, repository factory) that the W1-F generic ConnectorRegistry
 * hasn't standardised yet.
 *
 * Until W1-F publishes the runtime context shape, the contribution emits
 * `disconnected` for status checks and `transport_error` for send/read so
 * downstream task scheduling treats the connector as unavailable rather
 * than silently no-op'ing.
 */
function buildConnectorContribution(
  kind: (typeof HEALTH_CONNECTOR_KINDS)[number],
): ConnectorContribution {
  const stubStatus = async (): Promise<ConnectorStatus> => ({
    state: "disconnected",
    message:
      "plugin-health Wave-1 stub: full dispatcher wiring lands when W1-F's runtime context shape is finalised.",
    observedAt: new Date().toISOString(),
  });
  const stubSend = async (): Promise<DispatchResult> => ({
    ok: false,
    reason: "transport_error",
    userActionable: true,
    message:
      "plugin-health Wave-1 stub: connector send is not yet wired; configure via the legacy lifeops health-connectors path.",
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
      // Wave-1 stub — concrete start lives in `health-bridge.ts` /
      // `health-connectors.ts` and is invoked through the legacy
      // app-lifeops mixin path until W1-F's generic dispatcher lands.
    },
    disconnect: async () => {
      // Wave-1 stub — concrete disconnect lives in `health-oauth.ts`.
    },
    verify: async () => false,
    status: stubStatus,
    send: stubSend,
    read: async () => null,
  };
}

function buildAnchorContribution(anchorKey: string): AnchorContribution {
  return {
    anchorKey,
    description: `plugin-health anchor: ${anchorKey}`,
    source: "plugin-health",
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
      "Skipping plugin-health connector registration (registry not yet available)",
    );
    return;
  }
  for (const kind of HEALTH_CONNECTOR_KINDS) {
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
      "Skipping plugin-health anchor registration (registry not yet available)",
    );
    return;
  }
  for (const anchorKey of HEALTH_ANCHORS) {
    if (registry.get(anchorKey)) {
      continue;
    }
    registry.register(buildAnchorContribution(anchorKey));
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
      "Skipping plugin-health bus-family registration (registry not yet available)",
    );
    return;
  }
  for (const family of HEALTH_BUS_FAMILIES) {
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
