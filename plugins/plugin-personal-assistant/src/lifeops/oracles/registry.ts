/**
 * Runtime-local extension points for typed external facts and activity sources.
 *
 * Registry boundaries translate source failures into explicit unavailable
 * observations while retaining successful sources, so one provider outage
 * cannot masquerade as a healthy empty aggregate.
 */

import { type IAgentRuntime, isElizaError } from "@elizaos/core";
import {
  type LocalActivityOraclePayload,
  type LocalActivityOracleQuery,
  type OracleAdapter,
  type OracleKind,
  type OraclePayload,
  type OracleQuery,
  type OracleSnapshot,
  oracleError,
  unavailableOracleSnapshot,
} from "./contracts.js";

export class ExternalOracleRegistry {
  private readonly byKind = new Map<OracleKind, OracleAdapter>();

  register(adapter: OracleAdapter): void {
    if (this.byKind.has(adapter.kind)) {
      throw oracleError(
        `ExternalOracleRegistry: adapter "${adapter.kind}" already registered`,
        "ORACLE_ADAPTER_DUPLICATE",
        { kind: adapter.kind },
      );
    }
    this.byKind.set(adapter.kind, adapter);
  }

  get(kind: OracleKind): OracleAdapter | null {
    return this.byKind.get(kind) ?? null;
  }

  async observe(
    query: OracleQuery,
    now = new Date(),
  ): Promise<OracleSnapshot<OraclePayload>> {
    const adapter = this.byKind.get(query.kind);
    if (!adapter) {
      return unavailableOracleSnapshot({
        provider: "unregistered",
        resource: query.kind,
        coverage: "No source adapter registered",
        now,
        issue: {
          code: "ORACLE_ADAPTER_UNREGISTERED",
          message: "No source adapter is registered for this oracle kind.",
          scope: query.kind,
        },
      });
    }
    try {
      return await adapter.observe(query, now);
    } catch (error) {
      // error-policy:J1 The registry is the multi-provider boundary. It keeps
      // source failure distinct from a successful empty observation.
      return unavailableOracleSnapshot({
        provider: adapter.provider,
        resource: query.kind,
        coverage: "Provider request failed",
        now,
        issue: {
          code: isElizaError(error) ? error.code : "ORACLE_SOURCE_FAILED",
          message: "The external source is unavailable.",
          scope: query.kind,
        },
      });
    }
  }
}

export interface LocalActivitySourceAdapter {
  readonly provider: string;
  discover(
    query: LocalActivityOracleQuery,
    now?: Date,
  ): Promise<OracleSnapshot<LocalActivityOraclePayload>>;
}

export interface LocalActivitySourceObservation {
  source: string;
  snapshot: OracleSnapshot<LocalActivityOraclePayload>;
}

export class LocalActivityAdapterRegistry {
  private readonly sources = new Map<string, LocalActivitySourceAdapter>();

  register(source: string, adapter: LocalActivitySourceAdapter): void {
    const normalized = source.trim();
    if (normalized.length === 0) {
      throw oracleError(
        "Local activity source is required.",
        "LOCAL_ACTIVITY_SOURCE_INVALID",
      );
    }
    if (this.sources.has(normalized)) {
      throw oracleError(
        `LocalActivityAdapterRegistry: source "${normalized}" already registered`,
        "LOCAL_ACTIVITY_SOURCE_DUPLICATE",
        { source: normalized },
      );
    }
    this.sources.set(normalized, adapter);
  }

  list(): string[] {
    return [...this.sources.keys()];
  }

  async discoverAll(
    query: LocalActivityOracleQuery,
    now = new Date(),
  ): Promise<LocalActivitySourceObservation[]> {
    return Promise.all(
      [...this.sources.entries()].map(async ([source, adapter]) => {
        try {
          return {
            source,
            snapshot: await adapter.discover(query, now),
          };
        } catch (error) {
          // error-policy:J1 The activity registry is the fan-out boundary and
          // records provider failure without dropping healthy peer sources.
          return {
            source,
            snapshot: unavailableOracleSnapshot({
              provider: adapter.provider,
              resource: `local-activity:${source}`,
              coverage: "Provider request failed",
              now,
              issue: {
                code: isElizaError(error)
                  ? error.code
                  : "LOCAL_ACTIVITY_SOURCE_FAILED",
                message: "The local-activity source is unavailable.",
                scope: source,
              },
            }),
          };
        }
      }),
    );
  }
}

const oracleRegistries = new WeakMap<IAgentRuntime, ExternalOracleRegistry>();
const activityRegistries = new WeakMap<
  IAgentRuntime,
  LocalActivityAdapterRegistry
>();

export function registerExternalOracleRegistry(
  runtime: IAgentRuntime,
  registry: ExternalOracleRegistry,
): void {
  oracleRegistries.set(runtime, registry);
}

export function getExternalOracleRegistry(
  runtime: IAgentRuntime,
): ExternalOracleRegistry | null {
  return oracleRegistries.get(runtime) ?? null;
}

export function registerLocalActivityAdapterRegistry(
  runtime: IAgentRuntime,
  registry: LocalActivityAdapterRegistry,
): void {
  activityRegistries.set(runtime, registry);
}

export function getLocalActivityAdapterRegistry(
  runtime: IAgentRuntime,
): LocalActivityAdapterRegistry | null {
  return activityRegistries.get(runtime) ?? null;
}

export function resetOracleRegistriesForTests(runtime: IAgentRuntime): void {
  oracleRegistries.delete(runtime);
  activityRegistries.delete(runtime);
}
