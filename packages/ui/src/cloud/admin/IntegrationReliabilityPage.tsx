/**
 * /cloud/admin/integrations — integration reliability, cost, and release
 * dashboard. Renders per-provider health, error/latency/cost aggregates,
 * stale-sync and reauth signals, kill switches, release-evidence status, SLO
 * alerts, and the production account setup runbook checklist. Loading,
 * designed-empty, and error are three distinct states; the route-level
 * AdminGate owns the role gate and page chrome.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@elizaos/ui/cloud-ui";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "../lib/api-client";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";

interface KillSwitch {
  provider: string;
  capability: string | null;
  reason: string;
  actor: string | null;
  activatedAt: string | null;
}

interface ProviderReport {
  provider: string;
  health: "healthy" | "degraded" | "down" | "disabled" | "unknown";
  totals: { events: number; failures: number; errorRate: number };
  latency: { p50Ms: number | null; p95Ms: number | null; samples: number };
  costMicros: number;
  counts: {
    oauthErrors: number;
    webhookErrors: number;
    policyDenies: number;
    reauthRequired: number;
    killSwitchBlocks: number;
  };
  lastSyncAt: string | null;
  syncStale: boolean;
  killSwitches: KillSwitch[];
  evidence: {
    status: "verified" | "pending" | "missing";
    reference: string | null;
    verifiedAt: string | null;
  } | null;
}

interface ReliabilityResponse {
  success: boolean;
  data: {
    dashboard: {
      generatedAt: string;
      slo: {
        maxErrorRate: number;
        degradedErrorRate: number;
        maxP95LatencyMs: number;
        staleSyncAfterMs: number;
      };
      providers: ProviderReport[];
      alerts: { provider: string; code: string; message: string }[];
    };
    runbook: { id: string; title: string; description: string }[];
    invalidConfig: { killSwitches: string[]; releaseEvidence: string[] };
  };
}

const HEALTH_BADGE_VARIANT: Record<
  ProviderReport["health"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  healthy: "default",
  degraded: "secondary",
  down: "destructive",
  disabled: "destructive",
  unknown: "outline",
};

function formatCost(costMicros: number): string {
  return `$${(costMicros / 1_000_000).toFixed(4)}`;
}

export default function IntegrationReliabilityPage(): React.JSX.Element {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.admin.integrationReliability.metaTitle", {
      defaultValue: "Admin: Integration Reliability · Eliza Cloud",
    }),
  );

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["admin", "integration-reliability"],
    queryFn: () =>
      api<ReliabilityResponse>("/api/v1/admin/integrations/reliability"),
    staleTime: 30_000,
  });

  const payload = data?.data;
  const invalidConfigCount = payload
    ? payload.invalidConfig.killSwitches.length +
      payload.invalidConfig.releaseEvidence.length
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            {t("cloud.admin.integrationReliability.title", {
              defaultValue: "Integration Reliability",
            })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("cloud.admin.integrationReliability.subtitle", {
              defaultValue:
                "Provider health, errors, cost, latency, kill switches, and release evidence — secrets and PII redacted at ingest.",
            })}
          </p>
        </div>
        <Button onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          <span className="ml-2">
            {t("cloud.admin.integrationReliability.refresh", {
              defaultValue: "Refresh",
            })}
          </span>
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-destructive">
            {error instanceof Error
              ? error.message
              : t("cloud.admin.integrationReliability.loadFailed", {
                  defaultValue: "Failed to load the integration dashboard",
                })}
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("cloud.admin.integrationReliability.loading", {
            defaultValue: "Aggregating integration telemetry…",
          })}
        </div>
      )}

      {payload && (
        <>
          {invalidConfigCount > 0 && (
            <Card className="border-destructive">
              <CardContent className="p-4 text-sm text-destructive">
                {t("cloud.admin.integrationReliability.invalidConfig", {
                  defaultValue:
                    "Malformed operator config entries were rejected:",
                })}{" "}
                {[
                  ...payload.invalidConfig.killSwitches.map(
                    (code) => `kill-switch ${code}`,
                  ),
                  ...payload.invalidConfig.releaseEvidence.map(
                    (code) => `evidence ${code}`,
                  ),
                ].join(", ")}
              </CardContent>
            </Card>
          )}

          {payload.dashboard.alerts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t("cloud.admin.integrationReliability.alerts", {
                    defaultValue: "SLO alerts",
                  })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs">
                {payload.dashboard.alerts.map((alert) => (
                  <div
                    key={`${alert.provider}-${alert.code}-${alert.message}`}
                    className="flex items-start gap-2"
                  >
                    <Badge variant="secondary">{alert.provider}</Badge>
                    <span className="font-mono">{alert.code}</span>
                    <span className="text-muted-foreground">
                      {alert.message}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {payload.dashboard.providers.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                {t("cloud.admin.integrationReliability.empty", {
                  defaultValue:
                    "No integration telemetry recorded yet. Provider reports appear here once managed integrations emit events.",
                })}
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {payload.dashboard.providers.map((p) => (
                <Card
                  key={p.provider}
                  className={
                    p.health === "down" || p.health === "disabled"
                      ? "border-destructive"
                      : ""
                  }
                >
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between text-base">
                      <span>{p.provider}</span>
                      <Badge variant={HEALTH_BADGE_VARIANT[p.health]}>
                        {p.health}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div>
                      events: {p.totals.events} · failures: {p.totals.failures}{" "}
                      · error rate: {(p.totals.errorRate * 100).toFixed(1)}%
                    </div>
                    <div>
                      latency p50/p95: {p.latency.p50Ms ?? "—"}/
                      {p.latency.p95Ms ?? "—"} ms ({p.latency.samples} samples)
                    </div>
                    <div>cost: {formatCost(p.costMicros)}</div>
                    <div>
                      oauth: {p.counts.oauthErrors} · webhook:{" "}
                      {p.counts.webhookErrors} · policy denies:{" "}
                      {p.counts.policyDenies} · reauth:{" "}
                      {p.counts.reauthRequired} · blocked:{" "}
                      {p.counts.killSwitchBlocks}
                    </div>
                    <div>
                      last sync:{" "}
                      {p.lastSyncAt
                        ? new Date(p.lastSyncAt).toLocaleString()
                        : "—"}
                      {p.syncStale && (
                        <span className="ml-1 text-destructive">
                          {t("cloud.admin.integrationReliability.stale", {
                            defaultValue: "(stale)",
                          })}
                        </span>
                      )}
                    </div>
                    <div>
                      evidence:{" "}
                      {p.evidence
                        ? `${p.evidence.status}${p.evidence.reference ? ` (${p.evidence.reference})` : ""}`
                        : t("cloud.admin.integrationReliability.noEvidence", {
                            defaultValue: "none on file",
                          })}
                    </div>
                    {p.killSwitches.map((ks) => (
                      <div
                        key={`${ks.provider}-${ks.capability ?? "*"}`}
                        className="text-destructive"
                      >
                        {ks.capability ?? "provider"} disabled: {ks.reason}
                        {ks.actor ? ` — ${ks.actor}` : ""}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("cloud.admin.integrationReliability.runbook", {
                  defaultValue: "Production account setup runbook",
                })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {payload.runbook.map((item, index) => (
                <div key={item.id}>
                  <span className="font-medium">
                    {index + 1}. {item.title}
                  </span>
                  <p className="text-muted-foreground">{item.description}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            {t("cloud.admin.integrationReliability.generatedAt", {
              defaultValue: "Generated at",
            })}{" "}
            {new Date(payload.dashboard.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
