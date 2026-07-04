/**
 * Agent detail page (`/dashboard/agents/:id`).
 */

import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
import {
  formatHourlyRate,
  formatMonthlyEstimate,
} from "@elizaos/cloud-shared/lib/constants/agent-pricing-display";
import {
  Badge,
  DashboardErrorState,
  DashboardLoadingState,
} from "@elizaos/ui/cloud-ui";
import {
  AlertCircle,
  ArrowLeft,
  Cloud,
  ExternalLink,
  Server,
  Terminal,
} from "lucide-react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ApiError } from "../lib/api-client";
import { useDocumentTitle } from "../lib/use-document-title";
import { useRequireAuth } from "../lib/use-session-auth";
import { ElizaAgentActions } from "./components/agent-actions";
import { DockerLogsViewer } from "./components/docker-logs-viewer";
import { ElizaAgentBackupsPanel } from "./components/eliza-agent-backups-panel";
import { ElizaAgentLogsViewer } from "./components/eliza-agent-logs-viewer";
import { ElizaAgentTabs } from "./components/eliza-agent-tabs";
import { ElizaConnectButton } from "./components/eliza-connect-button";
import { useAgent } from "./lib/data/eliza-agents";
import { useT } from "./lib/i18n";
import { statusBadgeColor, statusDotColor } from "./lib/sandbox-status";

function formatDate(date: string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(date: string | null): string {
  if (!date) return "";
  return new Date(date).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeShort(
  date: string | null,
  t: ReturnType<typeof useT>,
): string {
  if (!date) return t("cloud.agents.detail.never", { defaultValue: "Never" });
  const d = new Date(date);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)
    return t("cloud.agents.detail.justNow", { defaultValue: "Just now" });
  if (diffMin < 60)
    return t("cloud.agents.detail.minutesAgo", {
      defaultValue: "{{n}}m ago",
      n: diffMin,
    });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)
    return t("cloud.agents.detail.hoursAgo", {
      defaultValue: "{{n}}h ago",
      n: diffH,
    });
  return formatDate(date);
}

export default function AgentDetailPage() {
  const t = useT();
  const session = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const enabled = session.ready && session.authenticated;
  const query = useAgent(enabled ? id : undefined);

  const titleId = id ? id.slice(0, 8) : "";
  useDocumentTitle(
    t("cloud.agents.detail.metaTitle", {
      defaultValue: "Agent {{id}} — Instances",
      id: titleId,
    }),
  );

  if (!session.ready || (enabled && query.isLoading)) {
    return (
      <DashboardLoadingState
        label={t("cloud.agents.detail.loading", {
          defaultValue: "Loading agent",
        })}
      />
    );
  }

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <Navigate to="/dashboard/agents" replace />;
  }
  if (query.error) {
    const msg =
      query.error instanceof Error
        ? query.error.message
        : t("cloud.agents.detail.errorFailedLoad", {
            defaultValue: "Failed to load agent",
          });
    return <DashboardErrorState message={msg} />;
  }

  const agent = query.data;
  if (!agent) return <Navigate to="/dashboard/agents" replace />;

  const badgeColor = statusBadgeColor(agent.status);
  const dotColor = statusDotColor(agent.status);
  const isRunningish =
    agent.status === "running" || agent.status === "provisioning";
  const isIdle = agent.status === "stopped" || agent.status === "disconnected";
  const adminDetails = agent.adminDetails;
  const isDockerBacked = adminDetails?.isDockerBacked ?? false;
  const showConnect = !!agent.webUiUrl && agent.status === "running";

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/dashboard/agents"
          className="group flex min-h-touch items-center gap-2 text-sm text-muted-strong hover:text-txt-strong transition-colors"
        >
          <div className="flex items-center justify-center w-7 h-7 bg-card group-hover:bg-bg-hover transition-colors">
            <ArrowLeft className="h-3.5 w-3.5" />
          </div>
          <span>
            {t("cloud.agents.detail.backToInstances", {
              defaultValue: "Instances",
            })}
          </span>
        </Link>

        <div className="flex items-center gap-2">
          {showConnect && <ElizaConnectButton agentId={agent.id} />}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <div className="flex items-center justify-center w-12 h-12 border border-accent/25 bg-accent-subtle shrink-0">
            {isDockerBacked ? (
              <Server className="h-6 w-6 text-accent" />
            ) : (
              <Cloud className="h-6 w-6 text-accent" />
            )}
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-semibold text-txt-strong truncate font-mono">
                {agent.agentName ??
                  t("cloud.agents.detail.unnamedAgent", {
                    defaultValue: "Unnamed Agent",
                  })}
              </h1>
              <Badge
                variant="outline"
                className={`${badgeColor} text-xs font-medium px-2 py-0.5`}
              >
                <span
                  className={`inline-block size-1.5 rounded-full mr-1.5 ${dotColor}`}
                />
                {agent.status}
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="font-mono tabular-nums">{agent.id}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-border border border-border">
        <div className="bg-card p-4 space-y-1">
          <p className="text-xs-tight uppercase tracking-[0.2em] text-muted">
            {t("cloud.agents.detail.statusLabel", { defaultValue: "Status" })}
          </p>
          <p className="text-lg font-medium text-txt-strong capitalize tabular-nums font-mono">
            {agent.status}
          </p>
        </div>
        <div className="bg-card p-4 space-y-1">
          <p className="text-xs-tight uppercase tracking-[0.2em] text-muted">
            {t("cloud.agents.detail.databaseLabel", {
              defaultValue: "Database",
            })}
          </p>
          <p className="text-lg font-medium text-txt-strong tabular-nums font-mono">
            {agent.databaseStatus === "ready"
              ? t("cloud.agents.detail.dbConnected", {
                  defaultValue: "Connected",
                })
              : agent.databaseStatus === "provisioning"
                ? t("cloud.agents.detail.dbSettingUp", {
                    defaultValue: "Setting up",
                  })
                : agent.databaseStatus === "none"
                  ? t("cloud.agents.detail.dbNone", { defaultValue: "None" })
                  : t("cloud.agents.detail.dbError", {
                      defaultValue: "Error",
                    })}
          </p>
        </div>
        <div className="bg-card p-4 space-y-1">
          <p className="text-xs-tight uppercase tracking-[0.2em] text-muted">
            {t("cloud.agents.detail.costLabel", { defaultValue: "Cost" })}
          </p>
          <p className="text-lg font-medium text-txt-strong tabular-nums font-mono">
            {isRunningish
              ? formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE)
              : isIdle
                ? formatHourlyRate(AGENT_PRICING.IDLE_HOURLY_RATE)
                : "—"}
          </p>
          {(isRunningish || isIdle) && (
            <p className="text-2xs text-muted tabular-nums">
              {isRunningish
                ? formatMonthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE)
                : formatMonthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE)}
            </p>
          )}
        </div>
        <div className="bg-card p-4 space-y-1">
          <p className="text-xs-tight uppercase tracking-[0.2em] text-muted">
            {t("cloud.agents.detail.createdLabel", {
              defaultValue: "Created",
            })}
          </p>
          <p className="text-lg font-medium text-txt-strong tabular-nums font-mono">
            {formatDate(agent.createdAt)}
          </p>
          <p className="text-2xs text-muted tabular-nums">
            {formatTime(agent.createdAt)}
          </p>
        </div>
        <div className="bg-card p-4 space-y-1">
          <p className="text-xs-tight uppercase tracking-[0.2em] text-muted">
            {t("cloud.agents.detail.lastHeartbeatLabel", {
              defaultValue: "Last Heartbeat",
            })}
          </p>
          <p className="text-lg font-medium text-txt-strong tabular-nums font-mono">
            {formatRelativeShort(agent.lastHeartbeatAt, t)}
          </p>
          {agent.lastHeartbeatAt && (
            <p className="text-2xs text-muted tabular-nums">
              {formatDate(agent.lastHeartbeatAt)}
            </p>
          )}
        </div>
      </div>

      <ElizaAgentTabs agentId={agent.id}>
        {agent.errorMessage && (
          <div className="flex items-start gap-3 p-4 bg-destructive-subtle border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-destructive">
                {t("cloud.agents.detail.errorWithCount", {
                  defaultValue: "Error ({{n}} occurrence{{plural}})",
                  n: agent.errorCount,
                  plural: agent.errorCount !== 1 ? "s" : "",
                })}
              </p>
              <p className="text-sm text-destructive/70">{agent.errorMessage}</p>
            </div>
          </div>
        )}

        {agent.webUiUrl && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 bg-accent" />
              <p className="font-mono text-xs-tight uppercase tracking-[0.32em] text-muted-strong">
                {t("cloud.agents.detail.webUi", { defaultValue: "Web UI" })}
              </p>
            </div>

            <div className="border border-border bg-card px-4 py-3 flex items-start gap-3 text-sm">
              <span className="text-xs-tight uppercase tracking-widest text-muted shrink-0 pt-0.5">
                {t("cloud.agents.detail.publicUrl", {
                  defaultValue: "Public URL",
                })}
              </span>
              <a
                href={agent.webUiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-strong hover:text-txt-strong font-mono text-xs break-all transition-colors"
              >
                {agent.webUiUrl}
              </a>
            </div>
          </section>
        )}

        {adminDetails && isDockerBacked && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 bg-accent" />
              <p className="font-mono text-xs-tight uppercase tracking-[0.32em] text-muted-strong">
                {t("cloud.agents.detail.infrastructure", {
                  defaultValue: "Infrastructure",
                })}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border">
              <InfoCell
                label={t("cloud.agents.detail.node", { defaultValue: "Node" })}
                value={adminDetails.nodeId ?? "—"}
                mono
              />
              <InfoCell
                label={t("cloud.agents.detail.container", {
                  defaultValue: "Container",
                })}
                value={adminDetails.containerName ?? "—"}
                mono
              />
              <InfoCell
                label={t("cloud.agents.detail.dockerImage", {
                  defaultValue: "Docker Image",
                })}
                value={adminDetails.dockerImage ?? "—"}
                mono
              />
              {adminDetails.headscaleIp && (
                <InfoCell
                  label={t("cloud.agents.detail.vpnIp", {
                    defaultValue: "VPN IP",
                  })}
                  value={adminDetails.headscaleIp}
                  mono
                  accent="success"
                />
              )}
              {adminDetails.bridgePort !== null && (
                <InfoCell
                  label={t("cloud.agents.detail.bridgePort", {
                    defaultValue: "Bridge Port",
                  })}
                  value={String(adminDetails.bridgePort)}
                  mono
                />
              )}
              {adminDetails.webUiPort !== null && (
                <InfoCell
                  label={t("cloud.agents.detail.webUiPort", {
                    defaultValue: "Web UI Port",
                  })}
                  value={String(adminDetails.webUiPort)}
                  mono
                />
              )}
            </div>
          </section>
        )}

        {adminDetails?.sshCommand && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 bg-accent" />
              <p className="font-mono text-xs-tight uppercase tracking-[0.32em] text-muted-strong">
                {t("cloud.agents.detail.sshAccess", {
                  defaultValue: "SSH Access",
                })}
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-3 px-4 py-3 border border-border bg-card">
                <Terminal className="h-4 w-4 text-status-success shrink-0" />
                <code className="text-sm text-status-success font-mono flex-1">
                  {adminDetails.sshCommand}
                </code>
              </div>
              {adminDetails.bridgePort !== null && adminDetails.headscaleIp && (
                <div className="flex items-center gap-3 px-4 py-3 border border-border bg-card">
                  <Terminal className="h-4 w-4 text-accent shrink-0" />
                  <code className="text-sm text-accent font-mono flex-1">
                    {`curl http://${adminDetails.headscaleIp}:${adminDetails.bridgePort}/health`}
                  </code>
                </div>
              )}
            </div>
          </section>
        )}

        {adminDetails && !isDockerBacked && agent.bridgeUrl && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 bg-accent" />
              <p className="font-mono text-xs-tight uppercase tracking-[0.32em] text-muted-strong">
                {t("cloud.agents.detail.sandboxConnection", {
                  defaultValue: "Sandbox Connection",
                })}
              </p>
            </div>

            <div className="border border-border bg-card px-4 py-3 flex items-start gap-3">
              <span className="text-xs-tight uppercase tracking-widest text-muted shrink-0 pt-0.5">
                {t("cloud.agents.detail.bridgeUrl", {
                  defaultValue: "Bridge URL",
                })}
              </span>
              <a
                href={agent.bridgeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-txt hover:text-txt-strong flex items-center gap-1 transition-colors font-mono break-all"
              >
                {agent.bridgeUrl}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
          </section>
        )}

        <ElizaAgentActions
          agentId={agent.id}
          executionTier={agent.executionTier}
          status={agent.status}
          webUiUrl={agent.webUiUrl}
        />

        <ElizaAgentBackupsPanel
          agentId={agent.id}
          agentName={
            agent.agentName ??
            t("cloud.agents.detail.unnamedAgent", {
              defaultValue: "Unnamed Agent",
            })
          }
          status={agent.status}
        />

        <ElizaAgentLogsViewer
          agentId={agent.id}
          agentName={
            agent.agentName ??
            t("cloud.agents.detail.unnamedAgent", {
              defaultValue: "Unnamed Agent",
            })
          }
          status={agent.status}
          showAdvancedHint={!!adminDetails && isDockerBacked}
        />

        {adminDetails &&
          isDockerBacked &&
          adminDetails.containerName &&
          adminDetails.nodeId && (
            <DockerLogsViewer
              sandboxId={agent.id}
              containerName={adminDetails.containerName}
              nodeId={adminDetails.nodeId}
            />
          )}
      </ElizaAgentTabs>
    </div>
  );
}

function InfoCell({
  label,
  value,
  mono = false,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "success" | "neutral" | "orange";
}) {
  const valueColor =
    accent === "success"
      ? "text-status-success"
      : accent === "orange"
        ? "text-accent"
        : "text-txt-strong";

  return (
    <div className="bg-card p-4 space-y-1 min-w-0">
      <p className="text-xs-tight uppercase tracking-[0.2em] text-muted">
        {label}
      </p>
      <p
        className={`text-sm font-medium ${valueColor} break-all ${mono ? "font-mono" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
