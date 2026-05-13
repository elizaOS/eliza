import {
  type AnalyticsAlertEvent,
  analyticsAlertEventsRepository,
  type NewAnalyticsAlertEvent,
} from "@/db/repositories/analytics-alert-events";
import type { ProjectionAlert, ProjectionDataPoint } from "@/lib/analytics/projections";
import type { TimeSeriesDataPoint } from "@/lib/services/analytics";

export type DashboardAlertSeverity = "warning" | "critical" | "info";

export interface PersistProjectionAlertsInput {
  organizationId: string;
  alerts: ProjectionAlert[];
  historicalData: TimeSeriesDataPoint[];
  projectedData: ProjectionDataPoint[];
  creditBalance: number;
  evaluatedAt?: Date;
}

function toSeverity(type: ProjectionAlert["type"]): DashboardAlertSeverity {
  if (type === "danger") return "critical";
  return type;
}

function policyId(alert: ProjectionAlert): string {
  return alert.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class AnalyticsAlertsService {
  async persistProjectionAlerts(
    input: PersistProjectionAlertsInput,
  ): Promise<AnalyticsAlertEvent[]> {
    const evaluatedAt = input.evaluatedAt ?? new Date();
    const events: NewAnalyticsAlertEvent[] = input.alerts.map((alert) => {
      const policy = policyId(alert);
      return {
        organization_id: input.organizationId,
        policy_id: policy,
        severity: toSeverity(alert.type),
        status: "open",
        source: "analytics.projections",
        title: alert.title,
        message: alert.message,
        evidence: {
          projectedValue: alert.projectedValue ?? null,
          projectedDate: alert.projectedDate?.toISOString?.() ?? null,
          historicalPoints: input.historicalData.length,
          projectedPoints: input.projectedData.filter((point) => point.isProjected).length,
          creditBalance: input.creditBalance,
        },
        dedupe_key: `analytics.projections:${policy}:${dayKey(evaluatedAt)}`,
        evaluated_at: evaluatedAt,
      };
    });

    return await analyticsAlertEventsRepository.createManyDeduped(events);
  }

  async listRecent(
    organizationId: string,
    options: { since?: Date; limit?: number } = {},
  ): Promise<AnalyticsAlertEvent[]> {
    return await analyticsAlertEventsRepository.listRecentByOrganization(organizationId, options);
  }
}

export const analyticsAlertsService = new AnalyticsAlertsService();
