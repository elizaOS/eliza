import {
  DashboardActionCards,
  DashboardActionCardsSkeleton,
  DashboardLoadingState,
  DashboardPageContainer,
  DashboardPageStack,
  DashboardPageWrapper,
} from "@elizaos/ui";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import type { DashboardAgentStats } from "@/lib/types/dashboard-agent-stats";
import { useT } from "@/providers/I18nProvider";
import { api } from "../lib/api-client";
import { useRequireAuth } from "../lib/auth-hooks";
import { useCreditsBalance } from "../lib/data/credits";
import {
  AgentsSection,
  AgentsSectionSkeleton,
} from "./_components/agents-section";

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
  const t = useT();
  const session = useRequireAuth();
  const dashboard = useDashboardData(session.ready && session.authenticated);
  const credits = useCreditsBalance();

  // Helmet must render even during the auth-loading short-circuit; without
  // this, the homepage <title> bleeds through while auth resolves.
  const head = (
    <Helmet>
      <title>
        {t("cloud.dashboard.metaTitle", {
          defaultValue: "Eliza Cloud Console",
        })}
      </title>
      <meta
        name="description"
        content={t("cloud.dashboard.metaDescription", {
          defaultValue:
            "Run your Eliza agent on the hosted runtime and manage runtime instances, API access, billing, connected devices, and monetization from the Eliza Cloud dashboard.",
        })}
      />
    </Helmet>
  );

  if (!session.ready)
    return (
      <>
        {head}
        <DashboardLoadingState
          label={t("cloud.dashboard.loading", {
            defaultValue: "Loading dashboard",
          })}
        />
      </>
    );

  const agents = dashboard.data?.agents ?? [];
  const creditBalance =
    typeof credits.data?.balance === "number" ? credits.data.balance : null;

  return (
    <>
      {head}
      <DashboardPageWrapper>
        <DashboardPageContainer>
          <DashboardPageStack className="pt-4 md:pt-6">
            <section className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div className="max-w-2xl">
                <p className="text-sm font-medium uppercase tracking-normal text-[#FF5800]">
                  {t("cloud.dashboard.eyebrow", {
                    defaultValue: "elizaOS Platform / Eliza Cloud",
                  })}
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-normal text-white md:text-4xl">
                  {t("cloud.dashboard.headline", {
                    defaultValue: "Run your Eliza agent on the hosted runtime",
                  })}
                </h1>
              </div>
            </section>

            <section>
              {credits.isLoading ? (
                <DashboardActionCardsSkeleton />
              ) : (
                <DashboardActionCards
                  creditBalance={creditBalance}
                  renderLink={({ to, className, children }) => (
                    <Link to={to} className={className}>
                      {children}
                    </Link>
                  )}
                />
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
