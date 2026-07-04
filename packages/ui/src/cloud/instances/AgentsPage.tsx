/**
 * Instances page (`/dashboard/agents`) — the hosted agent management table.
 */

import type { AgentListItemDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import {
  ContainersSkeleton,
  DashboardErrorState,
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
  const showAgentsError = enabled && agentsQuery.isError;

  return (
    <ElizaAgentsPageWrapper>
      <DashboardPageContainer className="space-y-6">
        {/* Page title is surfaced in the console top bar by
            ElizaAgentsPageWrapper (DashboardRoutePage title="Instances" →
            useSetPageHeader). No inline page-level heading here — a second
            "Instances" title under the top bar read as a double title. */}
        {showSkeleton ? (
          <ContainersSkeleton />
        ) : showAgentsError ? (
          <DashboardErrorState
            message={
              agentsQuery.error instanceof Error
                ? agentsQuery.error.message
                : t("cloud.agents.loadFailed", {
                    defaultValue: "Failed to load instances",
                  })
            }
          />
        ) : (
          <>
            <ElizaAgentPricingBanner
              runningCount={runningCount}
              idleCount={idleCount}
              creditBalance={creditBalance}
            />
            <ElizaAgentsTable sandboxes={sandboxes} />
          </>
        )}
      </DashboardPageContainer>
    </ElizaAgentsPageWrapper>
  );
}
