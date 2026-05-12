import {
  DashboardLoadingState,
  DashboardPageContainer,
  DashboardPageStack,
} from "@elizaos/cloud-ui";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import type { DashboardAgentStats } from "@/lib/types/dashboard-agent-stats";
import { api } from "../lib/api-client";
import { useRequireAuth } from "../lib/auth-hooks";
import { useCreditsBalance } from "../lib/data/credits";
import { AgentsSection, AgentsSectionSkeleton } from "./_components/agents-section";
import {
  DashboardActionCards,
  DashboardActionCardsSkeleton,
} from "./_components/dashboard-action-cards";
import { DashboardPageWrapper } from "./_components/dashboard-page-wrapper";

interface DashboardAgent {
  id: string;
  name: string;
  bio: string | string[];
  avatarUrl: string | null;
  category: string | null;
  isPublic: boolean;
  username?: string | null;
  stats?: DashboardAgentStats;
}

interface DashboardResponse {
  user: { name: string };
  agents: DashboardAgent[];
}

function useDashboardData(enabled: boolean) {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<DashboardResponse>("/api/v1/dashboard"),
    enabled,
  });
}

export default function DashboardPage() {
  const session = useRequireAuth();
  const dashboard = useDashboardData(session.ready && session.authenticated);
  const credits = useCreditsBalance();

  if (!session.ready) return <DashboardLoadingState label="Loading dashboard" />;

  const userName = dashboard.data?.user.name?.split(" ")[0] || "User";
  const agents = dashboard.data?.agents ?? [];
  const creditBalance = credits.data?.balance ?? 0;

  return (
    <>
      <Helmet>
        <title>Dashboard</title>
        <meta
          name="description"
          content="Manage your AI agents, instances, credits, and platform resources from the Eliza Cloud dashboard."
        />
      </Helmet>
      <DashboardPageWrapper userName={userName}>
        <DashboardPageContainer>
          <DashboardPageStack className="pt-4 md:pt-6">
            <section>
              {credits.isLoading ? (
                <DashboardActionCardsSkeleton />
              ) : (
                <DashboardActionCards creditBalance={creditBalance} />
              )}
            </section>

            <section>
              {dashboard.isLoading ? <AgentsSectionSkeleton /> : <AgentsSection agents={agents} />}
            </section>
          </DashboardPageStack>
        </DashboardPageContainer>
      </DashboardPageWrapper>
    </>
  );
}
