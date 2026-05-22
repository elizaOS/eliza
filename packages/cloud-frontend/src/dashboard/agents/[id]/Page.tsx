import { Badge, DashboardErrorState, DashboardLoadingState } from "@elizaos/ui";
import {
  AlertCircle,
  ArrowLeft,
  Cloud,
  ExternalLink,
  MessageCircle,
  Server,
  Terminal,
} from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link, Navigate, useParams } from "react-router-dom";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import {
  formatHourlyRate,
  formatMonthlyEstimate,
} from "@/lib/constants/agent-pricing-display";
import {
  statusBadgeColor,
  statusDotColor,
} from "@/lib/constants/sandbox-status";
import { useT } from "@/providers/I18nProvider";
import { ApiError } from "../../../lib/api-client";
import { useRequireAuth } from "../../../lib/auth-hooks";
import { useAgent } from "../../../lib/data/eliza-agents";
import { ElizaAgentActions } from "../_components/agent-actions";
import { DockerLogsViewer } from "../_components/docker-logs-viewer";
import { ElizaAgentBackupsPanel } from "../_components/eliza-agent-backups-panel";
import { ElizaAgentLogsViewer } from "../_components/eliza-agent-logs-viewer";
import { ElizaAgentTabs } from "../_components/eliza-agent-tabs";
import { ElizaConnectButton } from "../_components/eliza-connect-button";

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

  if (!session.ready || (enabled && query.isLoading)) {
    return (
      <>
        <Helmet>
          <title>
            {t("cloud.agents.detail.metaTitle", {
              defaultValue: "Agent {{id}} — Instances",
              id: titleId,
            })}
          </title>
        </Helmet>
        <DashboardLoadingState
          label={t("cloud.agents.detail.loading", {
            defaultValue: "Loading agent",
          })}
        />
      </>
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
  const showConnect = !!adminDetails?.webUiUrl && agent.status === "running";

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.agents.detail.metaTitle", {
            defaultValue: "Agent {{id}} — Instances",
            id: titleId,
          })}
        </title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <Link
            to="/dashboard/agents"
            className="group flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors"
          >
            <div className="flex items-center justify-center w-7 h-7 border border-white/10 bg-black/40 group-hover:border-[var(--brand-orange)]/40 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" />
            </div>
            <span>
              {t("cloud.agents.detail.backToInstances", {
                defaultValue: "Instances",
              })}
            </span>
          </Link>

          <div className="flex items-center gap-2">
            {agent.status === "running" && (
              <Link
                to={`/dashboard/agents/${agent.id}/chat`}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-sm font-medium border border-[var(--brand-orange)] bg-[var(--brand-orange)] text-black hover:bg-[var(--brand-orange)]/90 transition-colors"
              >
                <MessageCircle className="h-3.5 w-3.5" />
                {t("cloud.agents.detail.chat", { defaultValue: "Chat" })}
              </Link>
            )}
            {showConnect && <ElizaConnectButton agentId={agent.id} />}
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex items-center justify-center w-12 h-12 border border-[var(--brand-orange)]/25 bg-[var(--brand-orange)]/10 shrink-0">
              {isDockerBacked ? (
                <Server className="h-6 w-6 text-[var(--brand-orange)]" />
              ) : (
                <Cloud className="h-6 w-6 text-[var(--brand-orange)]" />
              )}
            </div>
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1
                  className="text-2xl font-semibold text-white truncate"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
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
              <div className="flex items-center gap-3 text-xs text-white/35">
                <span className="font-mono tabular-nums">{agent.id}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-white/5 border border-white/10">
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
              {t("cloud.agents.detail.statusLabel", { defaultValue: "Status" })}
            </p>
            <p
              className="text-lg font-medium text-white capitalize tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {agent.status}
            </p>
          </div>
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
              {t("cloud.agents.detail.databaseLabel", {
                defaultValue: "Database",
              })}
            </p>
            <p
              className="text-lg font-medium text-white tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
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
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
              {t("cloud.agents.detail.costLabel", { defaultValue: "Cost" })}
            </p>
            <p
              className="text-lg font-medium text-white tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {isRunningish
                ? formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE)
                : isIdle
                  ? formatHourlyRate(AGENT_PRICING.IDLE_HOURLY_RATE)
                  : "—"}
            </p>
            {(isRunningish || isIdle) && (
              <p className="text-[10px] text-white/30 tabular-nums">
                {isRunningish
                  ? formatMonthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE)
                  : formatMonthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE)}
              </p>
            )}
          </div>
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
              {t("cloud.agents.detail.createdLabel", {
                defaultValue: "Created",
              })}
            </p>
            <p
              className="text-lg font-medium text-white tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {formatDate(agent.createdAt)}
            </p>
            <p className="text-[10px] text-white/30 tabular-nums">
              {formatTime(agent.createdAt)}
            </p>
          </div>
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
              {t("cloud.agents.detail.lastHeartbeatLabel", {
                defaultValue: "Last Heartbeat",
              })}
            </p>
            <p
              className="text-lg font-medium text-white tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {formatRelativeShort(agent.lastHeartbeatAt, t)}
            </p>
            {agent.lastHeartbeatAt && (
              <p className="text-[10px] text-white/30 tabular-nums">
                {formatDate(agent.lastHeartbeatAt)}
              </p>
            )}
          </div>
        </div>

        <ElizaAgentTabs agentId={agent.id}>
          {agent.errorMessage && (
            <div className="flex items-start gap-3 p-4 bg-red-950/20 border border-red-500/20">
              <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium text-red-400">
                  {t("cloud.agents.detail.errorWithCount", {
                    defaultValue: "Error ({{n}} occurrence{{plural}})",
                    n: agent.errorCount,
                    plural: agent.errorCount !== 1 ? "s" : "",
                  })}
                </p>
                <p className="text-sm text-red-400/70">{agent.errorMessage}</p>
              </div>
            </div>
          )}

          {adminDetails && isDockerBacked && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-block size-2 bg-[var(--brand-orange)]" />
                <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/60">
                  {t("cloud.agents.detail.infrastructure", {
                    defaultValue: "Infrastructure",
                  })}
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-white/5 border border-white/10">
                <InfoCell
                  label={t("cloud.agents.detail.node", {
                    defaultValue: "Node",
                  })}
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
                    accent="emerald"
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

              {adminDetails.webUiUrl && (
                <div className="border border-white/10 bg-black/40 px-4 py-3 flex items-center gap-3 text-sm">
                  <span className="text-[11px] uppercase tracking-widest text-white/35 shrink-0">
                    {t("cloud.agents.detail.webUi", { defaultValue: "Web UI" })}
                  </span>
                  <span className="text-white/74 font-mono text-xs break-all">
                    {adminDetails.webUiUrl}
                  </span>
                </div>
              )}
            </section>
          )}

          {adminDetails?.sshCommand && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-block size-2 bg-[var(--brand-orange)]" />
                <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/60">
                  {t("cloud.agents.detail.sshAccess", {
                    defaultValue: "SSH Access",
                  })}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-3 px-4 py-3 border border-white/10 bg-black/60">
                  <Terminal className="h-4 w-4 text-green-400 shrink-0" />
                  <code
                    className="text-sm text-green-400 font-mono flex-1"
                    style={{ fontFamily: "var(--font-roboto-mono)" }}
                  >
                    {adminDetails.sshCommand}
                  </code>
                </div>
                {adminDetails.bridgePort !== null &&
                  adminDetails.headscaleIp && (
                    <div className="flex items-center gap-3 px-4 py-3 border border-white/10 bg-black/60">
                      <Terminal className="h-4 w-4 text-[#FF5800] shrink-0" />
                      <code
                        className="text-sm text-[#FF5800] font-mono flex-1"
                        style={{ fontFamily: "var(--font-roboto-mono)" }}
                      >
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
                <span className="inline-block size-2 bg-[var(--brand-orange)]" />
                <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/60">
                  {t("cloud.agents.detail.sandboxConnection", {
                    defaultValue: "Sandbox Connection",
                  })}
                </p>
              </div>

              <div className="border border-white/10 bg-black/40 px-4 py-3 flex items-start gap-3">
                <span className="text-[11px] uppercase tracking-widest text-white/35 shrink-0 pt-0.5">
                  {t("cloud.agents.detail.bridgeUrl", {
                    defaultValue: "Bridge URL",
                  })}
                </span>
                <a
                  href={agent.bridgeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-[var(--brand-orange)] hover:text-[var(--brand-orange)]/70 flex items-center gap-1 transition-colors font-mono break-all"
                >
                  {agent.bridgeUrl}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
            </section>
          )}

          <ElizaAgentActions agentId={agent.id} status={agent.status} />

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
    </>
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
  accent?: "emerald" | "neutral" | "orange";
}) {
  const valueColor =
    accent === "emerald"
      ? "text-green-400"
      : accent === "neutral"
        ? "text-white/80"
        : accent === "orange"
          ? "text-orange-400"
          : "text-white/80";

  return (
    <div className="bg-black/60 p-4 space-y-1 min-w-0">
      <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
        {label}
      </p>
      <p
        className={`text-sm font-medium ${valueColor} break-all ${mono ? "font-mono" : ""}`}
        style={mono ? { fontFamily: "var(--font-roboto-mono)" } : undefined}
      >
        {value}
      </p>
    </div>
  );
}
