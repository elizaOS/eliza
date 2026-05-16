import {
  DashboardLoadingState,
  DashboardPageContainer,
  DashboardPageStack,
} from "@elizaos/ui";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import type { DashboardAgentStats } from "@/lib/types/dashboard-agent-stats";
import { api } from "../lib/api-client";
import { useRequireAuth } from "../lib/auth-hooks";
import { useCreditsBalance } from "../lib/data/credits";
import {
  AgentsSection,
  AgentsSectionSkeleton,
} from "./_components/agents-section";
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

  if (!session.ready)
    return <DashboardLoadingState label="Loading dashboard" />;

  const userName = dashboard.data?.user.name?.split(" ")[0] || "User";
  const agents = dashboard.data?.agents ?? [];
  const creditBalance = credits.data?.balance ?? 0;

  return (
    <>
      <Helmet>
        <title>Eliza Cloud Console</title>
        <meta
          name="description"
          content="Run your Eliza agent on the hosted runtime and manage runtime instances, API access, billing, connected devices, and monetization from the Eliza Cloud dashboard."
        />
      </Helmet>
      <DashboardPageWrapper userName={userName}>
        <DashboardPageContainer>
          <DashboardPageStack className="pt-4 md:pt-6">
            <section className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div className="max-w-2xl">
                <p className="text-sm font-medium uppercase tracking-normal text-[#FF5800]">
                  ElizaOS Platform / Eliza Cloud
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-normal text-white md:text-4xl">
                  Run your Eliza agent on the hosted runtime
                </h1>
              </div>
            </section>

            <section>
              {credits.isLoading ? (
                <DashboardActionCardsSkeleton />
              ) : (
                <DashboardActionCards creditBalance={creditBalance} />
              )}
            </section>

            <section>
              {dashboard.isLoading ? (
                <AgentsSectionSkeleton />
              ) : (
                <AgentsSection agents={agents} />
              )}
            </section>
          </DashboardPageStack>
        </DashboardPageContainer>
      </DashboardPageWrapper>
    </>
  );
}
