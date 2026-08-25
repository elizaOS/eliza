/**
 * Agents page (`/cloud/agents`) — the hosted agent management table.
 */

import type { NormalizedAgentListItemDto } from "@elizaos/cloud-sdk";
import {
  Badge,
  ContainersSkeleton,
  DashboardErrorState,
  DashboardLoadingState,
  DashboardPageContainer,
  ElizaAgentsPageWrapper,
} from "@elizaos/ui/cloud-ui";
import { useDocumentTitle } from "../lib/use-document-title";
import { useSessionAuth } from "../lib/use-session-auth";
import { ElizaAgentActions } from "./components/agent-actions";
import { ElizaAgentPricingBanner } from "./components/eliza-agent-pricing-banner";
import { ElizaAgentsTable } from "./components/eliza-agents-table";
import { useCreditsBalance } from "./lib/data/credits";
import { useAgents, usePersonalElizaIdentity } from "./lib/data/eliza-agents";
import { useT } from "./lib/i18n";

export default function AgentsPage() {
  const t = useT();
  const session = useSessionAuth();
  const enabled = session.ready && session.authenticated;
  const agentsQuery = useAgents();
  const credits = useCreditsBalance();
  const personalQuery = usePersonalElizaIdentity();

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

  const agents: NormalizedAgentListItemDto[] = agentsQuery.data ?? [];
  // The list response does not expose a canonical/superseded cutover marker.
  // Keep every authoritative row visible: a dedicated target exists before its
  // readiness/import handoff completes, so presence alone cannot retire Shared.
  const visibleAgents = agents;
  const personalShared = personalQuery.data?.runtime === "shared";
  const sharedCount =
    visibleAgents.filter((a) => a.executionTier === "shared").length +
    (personalShared ? 1 : 0);
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
  const showSkeleton =
    enabled && (agentsQuery.isLoading || personalQuery.isLoading);
  const showAgentsError =
    enabled && (agentsQuery.isError || personalQuery.isError);

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
                : personalQuery.error instanceof Error
                  ? personalQuery.error.message
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
            {personalShared && personalQuery.data ? (
              <section className="rounded-xl border border-border bg-bg p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-txt-strong">
                        {personalQuery.data.displayName || "Eliza"}
                      </h2>
                      <Badge variant="secondary">Shared</Badge>
                      <Badge variant="outline">Free</Badge>
                    </div>
                    <p className="max-w-2xl text-sm leading-relaxed text-txt-muted">
                      Shared is ready instantly and uses pooled Cloud capacity.
                      Dedicated gives your Eliza private, always-on compute and
                      moves this conversation only after setup succeeds.
                    </p>
                  </div>
                  <ElizaAgentActions
                    agentId={personalQuery.data.id}
                    executionTier="shared"
                    status="running"
                  />
                </div>
              </section>
            ) : null}
            {visibleAgents.length > 0 ? (
              <ElizaAgentsTable agents={visibleAgents} />
            ) : personalShared ? null : (
              <ElizaAgentsTable agents={visibleAgents} />
            )}
          </>
        )}
      </DashboardPageContainer>
    </ElizaAgentsPageWrapper>
  );
}
