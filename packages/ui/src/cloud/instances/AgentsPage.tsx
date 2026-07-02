/**
 * Instances page (`/dashboard/agents`) — the hosted agent management table.
 */

import type { AgentListItemDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import {
  ContainersSkeleton,
  DashboardLoadingState,
  DashboardPageContainer,
  ElizaAgentsPageWrapper,
} from "@elizaos/ui/cloud-ui";
import { useDocumentTitle } from "../lib/use-document-title";
import { useRequireAuth } from "../lib/use-session-auth";
import { ElizaAgentPricingBanner } from "./components/eliza-agent-pricing-banner";
import {
  type ElizaAgentRow,
  ElizaAgentsTable,
} from "./components/eliza-agents-table";
import { useCreditsBalance } from "./lib/data/credits";
import { type AgentListItem, useAgents } from "./lib/data/eliza-agents";
import { useT } from "./lib/i18n";

function toAgentRow(a: AgentListItem): ElizaAgentRow {
  return {
    id: a.id,
    agent_name: a.agentName,
    status: a.status,
    canonical_web_ui_url: a.webUiUrl,
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: a.dockerImage,
    execution_tier: a.executionTier,
    sandbox_id: null,
    bridge_url: null,
    error_message: a.errorMessage,
    last_heartbeat_at: a.lastHeartbeatAt,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

export default function AgentsPage() {
  const t = useT();
  const session = useRequireAuth();
  const enabled = session.ready && session.authenticated;
  const agentsQuery = useAgents();
  const credits = useCreditsBalance();

  useDocumentTitle(t("cloud.agents.metaTitle", { defaultValue: "Instances" }));

  if (!session.ready) {
    return (
      <DashboardLoadingState
        label={t("cloud.agents.loading", {
          defaultValue: "Loading instances",
        })}
      />
    );
  }

  const agents: AgentListItemDto[] = agentsQuery.data ?? [];
  const sandboxes = agents.map(toAgentRow);
  const runningCount = agents.filter((a) => a.status === "running").length;
  const idleCount = agents.filter(
    (a) => a.status === "stopped" || a.status === "disconnected",
  ).length;
  const creditBalance =
    typeof credits.data?.balance === "number" ? credits.data.balance : null;
  const showSkeleton = enabled && agentsQuery.isLoading;

  return (
    <ElizaAgentsPageWrapper>
      <DashboardPageContainer className="space-y-6">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 bg-[#FF5800]" />
            <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/60">
              {t("cloud.agents.eyebrow", { defaultValue: "Instances" })}
            </p>
          </div>
          <h1 className="text-xl font-semibold text-white md:text-2xl">
            {t("cloud.agents.title", { defaultValue: "Instances" })}
          </h1>
        </div>

        <ElizaAgentPricingBanner
          runningCount={runningCount}
          idleCount={idleCount}
          creditBalance={creditBalance}
        />

        {showSkeleton ? (
          <ContainersSkeleton />
        ) : (
          <ElizaAgentsTable sandboxes={sandboxes} />
        )}
      </DashboardPageContainer>
    </ElizaAgentsPageWrapper>
  );
}
