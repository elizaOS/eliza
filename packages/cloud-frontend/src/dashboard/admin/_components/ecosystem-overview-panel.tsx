"use client";

import type { AdminInfrastructureSnapshot } from "@elizaos/cloud-shared/lib/services/admin-infrastructure";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@elizaos/ui";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  Database,
  Gauge,
  RefreshCw,
  Server,
  ShieldAlert,
  Users,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  AdminMetricsOverviewDto,
  AdminModerationOverviewResponse,
} from "@/lib/types/cloud-api";
import { ApiError, api } from "../../../lib/api-client";

interface SuccessEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface TelemetryRequest {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  dbCalls: number;
  duplicateDbReadCalls: number;
  createdAt: string;
}

interface TelemetrySnapshot {
  generatedAt: string;
  requests: TelemetryRequest[];
  slowRequests: TelemetryRequest[];
  slowDb: Array<{ label: string; durationMs: number; operation: string }>;
  burstyRequests: TelemetryRequest[];
  duplicateReadRequests: TelemetryRequest[];
}

interface AdminUsersResponse {
  users: Array<{ id: string; is_active: boolean; created_at: string }>;
  total: number;
}

interface AdminOrgsResponse {
  orgs: Array<{ id: string; is_active: boolean; created_at: string }>;
  total: number;
}

interface EcosystemSnapshot {
  infrastructure: AdminInfrastructureSnapshot | null;
  telemetry: TelemetrySnapshot | null;
  metrics: AdminMetricsOverviewDto | null;
  moderation: AdminModerationOverviewResponse | null;
  users: AdminUsersResponse | null;
  orgs: AdminOrgsResponse | null;
  errors: string[];
}

async function apiSuccess<T>(path: string): Promise<T> {
  const body = await api<SuccessEnvelope<T>>(path);
  if (!body.success || !body.data) {
    throw new Error(body.error ?? "Request failed");
  }
  return body.data;
}

function errorLabel(error: Error | ApiError | string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return error;
}

function resultValue<T>(
  result: PromiseSettledResult<T>,
  label: string,
  errors: string[],
): T | null {
  if (result.status === "fulfilled") return result.value;
  errors.push(`${label}: ${String(result.reason)}`);
  return null;
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function formatAge(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function EcosystemOverviewPanel() {
  const [snapshot, setSnapshot] = useState<EcosystemSnapshot>({
    infrastructure: null,
    telemetry: null,
    metrics: null,
    moderation: null,
    users: null,
    orgs: null,
    errors: [],
  });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const errors: string[] = [];
    const [infrastructure, telemetry, metrics, moderation, users, orgs] =
      await Promise.allSettled([
        apiSuccess<AdminInfrastructureSnapshot>("/api/v1/admin/infrastructure"),
        apiSuccess<TelemetrySnapshot>(
          "/api/v1/admin/cloud-observability?limit=60",
        ),
        api<AdminMetricsOverviewDto>(
          "/api/v1/admin/metrics?view=overview&timeRange=7d",
        ),
        api<AdminModerationOverviewResponse>(
          "/api/v1/admin/moderation?view=overview",
        ),
        api<AdminUsersResponse>("/api/v1/admin/users?limit=200"),
        api<AdminOrgsResponse>("/api/v1/admin/orgs?limit=200"),
      ]);

    setSnapshot({
      infrastructure: resultValue(infrastructure, "Infrastructure", errors),
      telemetry: resultValue(telemetry, "Telemetry", errors),
      metrics: resultValue(metrics, "Metrics", errors),
      moderation: resultValue(moderation, "Moderation", errors),
      users: resultValue(users, "Users", errors),
      orgs: resultValue(orgs, "Organizations", errors),
      errors,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const incidents = snapshot.infrastructure?.incidents.slice(0, 6) ?? [];
  const requests = snapshot.telemetry?.requests.slice(0, 6) ?? [];
  const activeUsers = useMemo(
    () => snapshot.users?.users.filter((user) => user.is_active).length ?? null,
    [snapshot.users],
  );
  const activeOrgs = useMemo(
    () => snapshot.orgs?.orgs.filter((org) => org.is_active).length ?? null,
    [snapshot.orgs],
  );
  const criticalIncidents =
    snapshot.infrastructure?.incidents.filter(
      (incident) => incident.severity === "critical",
    ).length ?? null;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Ecosystem Overview
          </h2>
          <p className="text-sm text-muted-foreground">
            Fleet health, users, organizations, backend telemetry, and
            moderation signals in one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard/admin/infrastructure">
              Infrastructure
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard/admin/metrics">
              Metrics
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {loading ? "Loading" : "Refresh"}
          </Button>
        </div>
      </div>

      {snapshot.errors.length > 0 && (
        <Card className="border-orange-500/40 bg-orange-500/5">
          <CardContent className="flex flex-col gap-2 py-4 text-sm text-orange-200">
            {snapshot.errors.slice(0, 4).map((error) => (
              <div key={error} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{errorLabel(error)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <OverviewMetric
          icon={Server}
          label="Fleet"
          value={`${formatNumber(snapshot.infrastructure?.summary.healthyNodes)} / ${formatNumber(snapshot.infrastructure?.summary.totalNodes)}`}
          detail="healthy nodes"
        />
        <OverviewMetric
          icon={Gauge}
          label="Capacity"
          value={`${formatNumber(snapshot.infrastructure?.summary.allocatedSlots)} / ${formatNumber(snapshot.infrastructure?.summary.totalCapacity)}`}
          detail={`${formatNumber(snapshot.infrastructure?.summary.utilizationPct)}% allocated`}
        />
        <OverviewMetric
          icon={Zap}
          label="Agents"
          value={formatNumber(
            snapshot.infrastructure?.summary.runningContainers,
          )}
          detail={`${formatNumber(snapshot.infrastructure?.summary.attentionContainers)} need attention`}
        />
        <OverviewMetric
          icon={Users}
          label="Users"
          value={formatNumber(activeUsers)}
          detail={`${formatNumber(snapshot.metrics?.newSignups7d)} signups in 7d`}
        />
        <OverviewMetric
          icon={Building2}
          label="Organizations"
          value={formatNumber(activeOrgs)}
          detail={`${formatNumber(snapshot.orgs?.total)} loaded`}
        />
        <OverviewMetric
          icon={ShieldAlert}
          label="Incidents"
          value={formatNumber(criticalIncidents)}
          detail={`${formatNumber(snapshot.moderation?.recentViolations.length)} recent violations`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4" />
                Live Incidents
              </CardTitle>
              <Badge variant="outline">
                {formatAge(snapshot.infrastructure?.refreshedAt)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {incidents.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No infrastructure incidents in the latest snapshot.
              </p>
            ) : (
              incidents.map((incident) => (
                <div
                  key={`${incident.scope}-${incident.title}-${incident.nodeId ?? ""}-${incident.containerId ?? ""}`}
                  className="grid gap-1 border-b pb-2 text-sm last:border-b-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        incident.severity === "critical"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {incident.severity}
                    </Badge>
                    <span className="font-medium">{incident.title}</span>
                  </div>
                  <p className="text-muted-foreground">{incident.detail}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4" />
              Backend Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
              <span>Method</span>
              <span className="col-span-2">Path</span>
              <span>Status</span>
            </div>
            {requests.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No request telemetry captured in this isolate yet.
              </p>
            ) : (
              requests.map((request) => (
                <div
                  key={request.id}
                  className="grid grid-cols-4 gap-2 border-b pb-2 text-xs last:border-b-0 last:pb-0"
                >
                  <span className="font-mono">{request.method}</span>
                  <span className="col-span-2 truncate font-mono">
                    {request.path}
                  </span>
                  <span className="font-mono">
                    {request.status} · {request.durationMs}ms
                  </span>
                </div>
              ))
            )}
            <div className="grid gap-2 pt-2 text-xs text-muted-foreground sm:grid-cols-3">
              <span>
                Slow: {formatNumber(snapshot.telemetry?.slowRequests.length)}
              </span>
              <span>
                Slow DB: {formatNumber(snapshot.telemetry?.slowDb.length)}
              </span>
              <span>
                Duplicate reads:{" "}
                {formatNumber(snapshot.telemetry?.duplicateReadRequests.length)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function OverviewMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Server;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
