import { DashboardLoadingState, DashboardPageContainer } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useCreditsBalance } from "../../lib/data/credits";
import { type AgentListItem, useAgents } from "../../lib/data/eliza-agents";
import { ContainersSkeleton } from "../containers/_components/containers-skeleton";
import { ElizaAgentPricingBanner } from "../containers/_components/eliza-agent-pricing-banner";
import { ElizaAgentsPageWrapper } from "../containers/_components/eliza-agents-page-wrapper";
import { type ElizaAgentRow, ElizaAgentsTable } from "../containers/_components/eliza-agents-table";

function toAgentRow(a: AgentListItem): ElizaAgentRow {
  return {
    id: a.id,
    agent_name: a.agentName,
    status: a.status,
    canonical_web_ui_url: null,
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: null,
    sandbox_id: null,
    bridge_url: null,
    error_message: a.errorMessage,
    last_heartbeat_at: a.lastHeartbeatAt,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

export default function AgentDashboardPage() {
  const session = useRequireAuth();
  const enabled = session.ready && session.authenticated;
  const agentsQuery = useAgents();
  const credits = useCreditsBalance();

  if (!session.ready) return <DashboardLoadingState label="Loading instances" />;

  const agents = agentsQuery.data ?? [];
  const sandboxes = agents.map(toAgentRow);
  const runningCount = agents.filter((a) => a.status === "running").length;
  const idleCount = agents.filter(
    (a) => a.status === "stopped" || a.status === "disconnected",
  ).length;
  const creditBalance = credits.data?.balance ?? 0;
  const showSkeleton = enabled && agentsQuery.isLoading;

  return (
    <>
      <Helmet>
        <title>Instances</title>
        <meta
          name="description"
          content="View, launch, and manage your instances backed by Eliza Cloud."
        />
      </Helmet>
      <ElizaAgentsPageWrapper>
        <DashboardPageContainer className="space-y-6">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-block size-2 bg-[#FF5800]" />
              <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/60">
                Instances
              </p>
            </div>
            <h1 className="text-xl font-semibold text-white md:text-2xl">Instances</h1>
          </div>

          <ElizaAgentPricingBanner
            runningCount={runningCount}
            idleCount={idleCount}
            creditBalance={creditBalance}
          />

          {showSkeleton ? <ContainersSkeleton /> : <ElizaAgentsTable sandboxes={sandboxes} />}
        </DashboardPageContainer>
      </ElizaAgentsPageWrapper>
    </>
  );
}
