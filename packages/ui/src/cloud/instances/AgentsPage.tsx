/**
 * Agents page (`/cloud/agents`) — the hosted agent management table.
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
import { useSessionAuth } from "../lib/use-session-auth";
import { ElizaAgentPricingBanner } from "./components/eliza-agent-pricing-banner";
import { ElizaAgentsTable } from "./components/eliza-agents-table";
import { useCreditsBalance } from "./lib/data/credits";
import { useAgents } from "./lib/data/eliza-agents";
import { useT } from "./lib/i18n";

export default function AgentsPage() {
  const t = useT();
  const session = useSessionAuth();
  const enabled = session.ready && session.authenticated;
  const agentsQuery = useAgents();
  const credits = useCreditsBalance();

  useDocumentTitle(t("cloud.agents.metaTitle", { defaultValue: "Agents" }));

  if (!session.ready) {
    return (
      <DashboardLoadingState
        label={t("cloud.agents.loading", {
          defaultValue: "Loading agents",
        })}
      />
    );
  }

  const agents: AgentListItemDto[] = agentsQuery.data ?? [];
  // The list response does not expose a canonical/superseded cutover marker.
  // Keep every authoritative row visible: a dedicated target exists before its
  // readiness/import handoff completes, so presence alone cannot retire Shared.
  const visibleAgents = agents;
  const sharedCount = visibleAgents.filter(
    (a) => a.executionTier === "shared",
  ).length;
  const runningCount = visibleAgents.filter(
    (a) => a.executionTier !== "shared" && a.status === "running",
  ).length;
  const idleCount = visibleAgents.filter(
    (a) =>
      a.executionTier !== "shared" &&
      (a.status === "stopped" || a.status === "disconnected"),
  ).length;
  const creditBalance =
    typeof credits.data?.balance === "number" ? credits.data.balance : null;
  const showSkeleton = enabled && agentsQuery.isLoading;
  const showAgentsError = enabled && agentsQuery.isError;

  return (
    <ElizaAgentsPageWrapper>
      <DashboardPageContainer className="space-y-6">
        {/* Page title is surfaced in the console top bar by
            ElizaAgentsPageWrapper (DashboardRoutePage title="Agents" →
            useSetPageHeader). No inline page-level heading here — a second
            "Agents" title under the top bar read as a double title. */}
        {showSkeleton ? (
          <ContainersSkeleton />
        ) : showAgentsError ? (
          <DashboardErrorState
            message={
              agentsQuery.error instanceof Error
                ? agentsQuery.error.message
                : t("cloud.agents.loadFailed", {
                    defaultValue: "Failed to load agents",
                  })
            }
          />
        ) : (
          <>
            <ElizaAgentPricingBanner
              sharedCount={sharedCount}
              runningCount={runningCount}
              idleCount={idleCount}
              creditBalance={creditBalance}
            />
            <ElizaAgentsTable agents={visibleAgents} />
          </>
        )}
      </DashboardPageContainer>
    </ElizaAgentsPageWrapper>
  );
}
