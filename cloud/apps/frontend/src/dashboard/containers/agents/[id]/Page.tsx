import { Badge, DashboardErrorState, DashboardLoadingState } from "@elizaos/cloud-ui";
import { AlertCircle, ArrowLeft, Cloud, ExternalLink, Terminal } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link, Navigate, useParams } from "react-router-dom";
import { ApiError } from "../../../../lib/api-client";
import { useRequireAuth } from "../../../../lib/auth-hooks";
import { useAgent } from "../../../../lib/data/eliza-agents";
import { ElizaAgentActions } from "../../_components/agent-actions";
import { DockerLogsViewer } from "../../_components/docker-logs-viewer";
import { ElizaAgentBackupsPanel } from "../../_components/eliza-agent-backups-panel";
import { ElizaAgentLogsViewer } from "../../_components/eliza-agent-logs-viewer";
import { ElizaConnectButton } from "../../_components/eliza-connect-button";

function statusBadgeColor(status: string): string {
  switch (status) {
    case "running":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "provisioning":
    case "pending":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "failed":
    case "error":
      return "border-red-500/40 bg-red-500/10 text-red-300";
    case "suspended":
    case "stopped":
      return "border-white/20 bg-white/5 text-white/60";
    default:
      return "border-white/20 bg-white/5 text-white/60";
  }
}

function statusDotColor(status: string): string {
  switch (status) {
    case "running":
      return "bg-emerald-400";
    case "provisioning":
    case "pending":
      return "bg-amber-400";
    case "failed":
    case "error":
      return "bg-red-400";
    default:
      return "bg-white/30";
  }
}

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

function formatRelativeShort(date: string | null): string {
  if (!date) return "Never";
  const diffMs = Date.now() - new Date(date).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return formatDate(date);
}

/** /dashboard/containers/agents/:id — Agent (eliza) agent detail. */
export default function AgentDetailPage() {
  const session = useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const { data: agent, isLoading, error } = useAgent(id);

  if (!session.ready || (session.authenticated && isLoading)) {
    return (
      <>
        <Helmet>
          <title>Agent — Containers</title>
        </Helmet>
        <DashboardLoadingState label="Loading agent" />
      </>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return <Navigate to="/dashboard/containers" replace />;
  }
  if (error) {
    return <DashboardErrorState message={error.message} />;
  }
  if (!agent) {
    return <Navigate to="/dashboard/containers" replace />;
  }

  const badgeColor = statusBadgeColor(agent.status);
  const dotColor = statusDotColor(agent.status);
  const agentName = agent.agentName ?? "Unnamed Agent";
  const adminDetails = agent.adminDetails;
  const isDockerBacked = adminDetails?.isDockerBacked ?? false;

  return (
    <>
      <Helmet>
        <title>{`${agentName} — Containers`}</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <Link
            to="/dashboard/containers"
            className="group flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors"
          >
            <div className="flex items-center justify-center w-7 h-7 border border-white/10 bg-black/40 group-hover:border-[#FF5800]/40 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" />
            </div>
            <span>Containers</span>
          </Link>

          {agent.status === "running" && <ElizaConnectButton agentId={agent.id} />}
        </div>

        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex items-center justify-center w-12 h-12 border border-[#FF5800]/25 bg-[#FF5800]/10 shrink-0">
              <Cloud className="h-6 w-6 text-[#FF5800]" />
            </div>
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1
                  className="text-2xl font-semibold text-white truncate"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {agentName}
                </h1>
                <Badge
                  variant="outline"
                  className={`${badgeColor} text-xs font-medium px-2 py-0.5`}
                >
                  <span className={`inline-block size-1.5 rounded-full mr-1.5 ${dotColor}`} />
                  {agent.status}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-white/35">
                <span className="font-mono tabular-nums">{agent.id}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/5 border border-white/10">
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">Status</p>
            <p
              className="text-lg font-medium text-white capitalize tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {agent.status}
            </p>
          </div>
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">Database</p>
            <p
              className="text-lg font-medium text-white tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {agent.databaseStatus === "ready"
                ? "Connected"
                : agent.databaseStatus === "provisioning"
                  ? "Setting up"
                  : agent.databaseStatus === "none"
                    ? "None"
                    : "Error"}
            </p>
          </div>
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">Created</p>
            <p
              className="text-lg font-medium text-white tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {formatDate(agent.createdAt)}
            </p>
            <p className="text-[10px] text-white/30 tabular-nums">{formatTime(agent.createdAt)}</p>
          </div>
          <div className="bg-black/60 p-4 space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">Last Heartbeat</p>
            <p
              className="text-lg font-medium text-white tabular-nums"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {formatRelativeShort(agent.lastHeartbeatAt)}
            </p>
            {agent.lastHeartbeatAt && (
              <p className="text-[10px] text-white/30 tabular-nums">
                {formatDate(agent.lastHeartbeatAt)}
              </p>
            )}
          </div>
        </div>

        {agent.errorMessage && (
          <div className="flex items-start gap-3 p-4 bg-red-950/20 border border-red-500/20">
            <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-red-400">
                Error ({agent.errorCount} occurrence
                {agent.errorCount !== 1 ? "s" : ""})
              </p>
              <p className="text-sm text-red-400/70">{agent.errorMessage}</p>
            </div>
          </div>
        )}

        {adminDetails && isDockerBacked && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 bg-[#FF5800]" />
              <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/60">
                Infrastructure
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-white/5 border border-white/10">
              <InfoCell label="Node" value={adminDetails.nodeId ?? "—"} mono />
              <InfoCell label="Container" value={adminDetails.containerName ?? "—"} mono />
              <InfoCell label="Docker Image" value={adminDetails.dockerImage ?? "—"} mono />
              {adminDetails.headscaleIp && (
                <InfoCell label="VPN IP" value={adminDetails.headscaleIp} mono accent="emerald" />
              )}
              {adminDetails.bridgePort !== null && (
                <InfoCell label="Bridge Port" value={String(adminDetails.bridgePort)} mono />
              )}
              {adminDetails.webUiPort !== null && (
                <InfoCell label="Web UI Port" value={String(adminDetails.webUiPort)} mono />
              )}
            </div>

            {adminDetails.webUiUrl && (
              <div className="border border-white/10 bg-black/40 px-4 py-3 flex items-center gap-3 text-sm">
                <span className="text-[11px] uppercase tracking-widest text-white/35 shrink-0">
                  Web UI
                </span>
                <span className="text-white/50 font-mono text-xs break-all">
                  {adminDetails.webUiUrl}
                </span>
              </div>
            )}
          </section>
        )}

        {adminDetails?.sshCommand && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 bg-[#FF5800]" />
              <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/60">
                SSH Access
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-3 px-4 py-3 border border-white/10 bg-black/60">
                <Terminal className="h-4 w-4 text-emerald-400 shrink-0" />
                <code
                  className="text-sm text-emerald-400 font-mono flex-1"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {adminDetails.sshCommand}
                </code>
              </div>
              {adminDetails.bridgePort !== null && adminDetails.headscaleIp && (
                <div className="flex items-center gap-3 px-4 py-3 border border-white/10 bg-black/60">
                  <Terminal className="h-4 w-4 text-blue-400 shrink-0" />
                  <code
                    className="text-sm text-blue-400 font-mono flex-1"
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
              <span className="inline-block size-2 bg-[#FF5800]" />
              <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/60">
                Sandbox Connection
              </p>
            </div>

            <div className="border border-white/10 bg-black/40 px-4 py-3 flex items-start gap-3">
              <span className="text-[11px] uppercase tracking-widest text-white/35 shrink-0 pt-0.5">
                Bridge URL
              </span>
              <a
                href={agent.bridgeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[#FF5800] hover:text-[#FF5800]/70 flex items-center gap-1 transition-colors font-mono break-all"
              >
                {agent.bridgeUrl}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
          </section>
        )}

        <ElizaAgentActions agentId={agent.id} status={agent.status} />

        <ElizaAgentBackupsPanel agentId={agent.id} agentName={agentName} status={agent.status} />

        <ElizaAgentLogsViewer agentId={agent.id} agentName={agentName} status={agent.status} />

        {adminDetails && isDockerBacked && adminDetails.containerName && adminDetails.nodeId && (
          <DockerLogsViewer
            sandboxId={agent.id}
            containerName={adminDetails.containerName}
            nodeId={adminDetails.nodeId}
          />
        )}
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
  accent?: "emerald" | "blue" | "orange";
}) {
  const valueColor =
    accent === "emerald"
      ? "text-emerald-400"
      : accent === "blue"
        ? "text-blue-400"
        : accent === "orange"
          ? "text-orange-400"
          : "text-white/80";

  return (
    <div className="bg-black/60 p-4 space-y-1 min-w-0">
      <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">{label}</p>
      <p
        className={`text-sm font-medium ${valueColor} break-all ${mono ? "font-mono" : ""}`}
        style={mono ? { fontFamily: "var(--font-roboto-mono)" } : undefined}
      >
        {value}
      </p>
    </div>
  );
}
