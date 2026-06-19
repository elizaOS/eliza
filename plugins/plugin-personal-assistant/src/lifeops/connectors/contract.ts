/**
 * Connector contract.
 *
 * Capability strings are namespaced (e.g. `"google.calendar.read"`,
 * `"telegram.send"`, `"apple_health.read"`) so multiple connectors can advertise
 * overlapping capabilities and the runtime can resolve dispatchers without
 * pattern-matching on `kind`.
 */

export type ConnectorMode = "local" | "cloud";

export interface ConnectorStatus {
  state: "ok" | "degraded" | "disconnected";
  message?: string;
  observedAt: string;
}

// The typed dispatch result is the scheduling spine's contract — it now lives
// in @elizaos/plugin-scheduling (the runner consumes it). Imported here for the
// connector contract below + re-exported so PA's connector layer (which produces
// these values) keeps importing it from this module unchanged.
import type { DispatchResult } from "@elizaos/plugin-scheduling";

export type { DispatchResult };

/**
 * OAuth surface a connector contribution may advertise. URL provided by the
 * connector contribution; the dispatcher does not hardcode. Audit C top-3
 * (rigidity-hunt-audit.md §3) — externalising these URLs lets adding a
 * fifth health provider register a contribution instead of editing
 * dispatcher switches.
 */
export interface ConnectorOAuthConfig {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl?: string | null;
  readonly scopes?: readonly string[];
}

export interface ConnectorContribution {
  /**
   * Stable connector key — `"google"`, `"telegram"`, `"discord"`,
   * `"apple_health"`, etc. Used as the registry lookup key.
   */
  kind: string;

  /**
   * Namespaced capability strings the connector advertises.
   *
   * Examples: `"google.calendar.read"`, `"google.gmail.draft.create"`,
   * `"telegram.send"`, `"apple_health.read"`, `"strava.read"`.
   */
  capabilities: string[];

  modes: ConnectorMode[];

  describe: { label: string };

  /**
   * Optional OAuth config — URL provided by the connector contribution; the
   * dispatcher does not hardcode. Health-bridge connectors (Strava, Fitbit,
   * Withings, Oura) populate this so the OAuth driver iterates the registry.
   */
  oauth?: ConnectorOAuthConfig;

  /**
   * Optional API base URL for authenticated requests — URL provided by the
   * connector contribution; the dispatcher does not hardcode.
   */
  apiBaseUrl?: string;

  start(): Promise<void>;
  disconnect(): Promise<void>;
  verify(): Promise<boolean>;
  status(): Promise<ConnectorStatus>;

  /**
   * Optional outbound dispatch verb. The payload shape is connector-specific;
   * the registry does not validate it. Connectors that contribute send-capable
   * channels should also surface a {@link import("../channels/contract.js").ChannelContribution}.
   */
  send?(payload: unknown): Promise<DispatchResult>;

  /**
   * Optional read verb. The query and return shape are connector-specific.
   */
  read?(query: unknown): Promise<unknown>;

  /**
   * When `true`, the runtime gates this connector's outbound `send` calls
   * through the owner-send-policy (e.g. Gmail draft → owner approval).
   */
  requiresApproval?: boolean;
}

export interface ConnectorRegistryFilter {
  capability?: string;
  mode?: ConnectorMode;
}

export interface ConnectorRegistry {
  register(c: ConnectorContribution): void;
  list(filter?: ConnectorRegistryFilter): ConnectorContribution[];
  get(kind: string): ConnectorContribution | null;
  byCapability(capability: string): ConnectorContribution[];
}
