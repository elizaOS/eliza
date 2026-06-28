import type {
  HealthBackend,
  HealthDailySummary,
  HealthDataPoint,
} from "@elizaos/plugin-health";
import type {
  DisconnectLifeOpsHealthConnectorRequest,
  GetLifeOpsHealthSummaryRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthSummaryResponse,
  StartLifeOpsHealthConnectorRequest,
  StartLifeOpsHealthConnectorResponse,
  SyncLifeOpsHealthConnectorRequest,
} from "../contracts/index.js";
import { HealthDomain } from "./domains/health-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export type LifeOpsHealthServicePublic = {
  getHealthConnectorStatus(): Promise<{
    available: boolean;
    backend: HealthBackend;
    lastCheckedAt: string;
  }>;
  getHealthDataConnectorStatuses(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus[]>;
  getHealthDataConnectorStatus(
    provider: LifeOpsHealthConnectorProvider,
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus>;
  startHealthConnector(
    request: StartLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsHealthConnectorResponse>;
  completeHealthConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus>;
  disconnectHealthConnector(
    request: DisconnectLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus>;
  syncHealthConnectors(
    request?: SyncLifeOpsHealthConnectorRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
  getHealthSummary(
    request?: GetLifeOpsHealthSummaryRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
  getHealthDailySummary(date: string): Promise<HealthDailySummary>;
  getHealthTrend(days: number): Promise<HealthDailySummary[]>;
  getHealthDataPoints(opts: {
    metric: HealthDataPoint["metric"];
    startAt: string;
    endAt: string;
  }): Promise<HealthDataPoint[]>;
};

/** @internal */
export function withHealth<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsHealthServicePublic> {
  class LifeOpsHealthServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly healthDomain = new HealthDomain(this);

    getHealthConnectorStatus(): Promise<{
      available: boolean;
      backend: HealthBackend;
      lastCheckedAt: string;
    }> {
      return this.healthDomain.getHealthConnectorStatus();
    }

    getHealthDataConnectorStatuses(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsHealthConnectorStatus[]> {
      return this.healthDomain.getHealthDataConnectorStatuses(
        requestUrl,
        requestedMode,
        requestedSide,
      );
    }

    getHealthDataConnectorStatus(
      provider: LifeOpsHealthConnectorProvider,
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsHealthConnectorStatus> {
      return this.healthDomain.getHealthDataConnectorStatus(
        provider,
        requestUrl,
        requestedMode,
        requestedSide,
      );
    }

    startHealthConnector(
      request: StartLifeOpsHealthConnectorRequest,
      requestUrl: URL,
    ): Promise<StartLifeOpsHealthConnectorResponse> {
      return this.healthDomain.startHealthConnector(request, requestUrl);
    }

    completeHealthConnectorCallback(
      callbackUrl: URL,
    ): Promise<LifeOpsHealthConnectorStatus> {
      return this.healthDomain.completeHealthConnectorCallback(callbackUrl);
    }

    disconnectHealthConnector(
      request: DisconnectLifeOpsHealthConnectorRequest,
      requestUrl: URL,
    ): Promise<LifeOpsHealthConnectorStatus> {
      return this.healthDomain.disconnectHealthConnector(request, requestUrl);
    }

    syncHealthConnectors(
      request?: SyncLifeOpsHealthConnectorRequest,
    ): Promise<LifeOpsHealthSummaryResponse> {
      return this.healthDomain.syncHealthConnectors(request);
    }

    getHealthSummary(
      request?: GetLifeOpsHealthSummaryRequest,
    ): Promise<LifeOpsHealthSummaryResponse> {
      return this.healthDomain.getHealthSummary(request);
    }

    getHealthDailySummary(date: string): Promise<HealthDailySummary> {
      return this.healthDomain.getHealthDailySummary(date);
    }

    getHealthTrend(days: number): Promise<HealthDailySummary[]> {
      return this.healthDomain.getHealthTrend(days);
    }

    getHealthDataPoints(opts: {
      metric: HealthDataPoint["metric"];
      startAt: string;
      endAt: string;
    }): Promise<HealthDataPoint[]> {
      return this.healthDomain.getHealthDataPoints(opts);
    }
  }

  return LifeOpsHealthServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsHealthServicePublic
  >;
}
