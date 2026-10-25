/**
 * Health service mixin: declares the LifeOps health service surface and the
 * `withHealth` mixin that composes the health domain's connect/disconnect and
 * summary methods onto the LifeOpsService base.
 */

import type {
  DisconnectLifeOpsHealthConnectorRequest,
  GetLifeOpsHealthSummaryRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthSummaryResponse,
  SyncLifeOpsHealthConnectorRequest,
} from "@elizaos/contracts";
import type {
  HealthBackend,
  HealthDailySummary,
  HealthDataPoint,
} from "@elizaos/plugin-health";

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
  getHealthDailySummary(
    date: string,
    window: { timeZone: string },
  ): Promise<HealthDailySummary>;
  getHealthTrend(
    days: number,
    window: { timeZone: string },
  ): Promise<HealthDailySummary[]>;
  getHealthDataPoints(
    opts: {
      metric: HealthDataPoint["metric"];
      startAt: string;
      endAt: string;
    },
    window: { timeZone: string },
  ): Promise<HealthDataPoint[]>;
};
