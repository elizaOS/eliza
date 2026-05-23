import {
  BrandButton,
  DashboardLoadingState,
  DashboardPageContainer,
  DashboardPageStack,
  DashboardPageWrapper,
} from "@elizaos/ui";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  CreditCard,
  KeyRound,
  Server,
  Share2,
  Store,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useDashboardReferralMe } from "@/dashboard/affiliates/_components/use-dashboard-referral-me";
import type { DashboardAgentStats } from "@/lib/types/dashboard-agent-stats";
import { useT } from "@/providers/I18nProvider";
import { api } from "../lib/api-client";
import { useRequireAuth } from "../lib/auth-hooks";
import { useApiKeys } from "../lib/data/api-keys";
import { useApps } from "../lib/data/apps";
import { useCreditsBalance } from "../lib/data/credits";
import { useAgents } from "../lib/data/eliza-agents";
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

function formatBalance(balance: number | null | undefined): string {
  if (typeof balance !== "number") return "—";
  if (balance >= 1) return `$${balance.toFixed(2)}`;
  if (balance > 0) return `$${balance.toFixed(4)}`;
  return "$0.00";
}

// Neutral resting → subtle white-opacity on hover. No blue, no orange→black.
const NEUTRAL_CARD =
  "group relative flex h-full flex-col justify-between gap-4 rounded-sm border border-white/10 bg-white/[0.04] p-5 text-white transition-colors duration-200 hover:bg-white/[0.07] hover:border-white/20";

// Orange resting → darker orange on hover.
const ACCENT_CARD =
  "group relative flex h-full flex-col justify-between gap-4 rounded-sm border border-[#FF5800] bg-[#FF5800] p-5 text-black transition-colors duration-200 hover:bg-[#E04E00] hover:border-[#E04E00]";

interface StatCardProps {
  to: string;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  isLoading?: boolean;
}

function StatCard({
  to,
  icon,
  label,
  value,
  caption,
  isLoading,
}: StatCardProps) {
  return (
    <Link to={to} className={NEUTRAL_CARD}>
      <div className="flex items-center justify-between">
        <span className="text-white/70">{icon}</span>
        <ArrowRight className="h-4 w-4 text-white/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/70" />
      </div>
      <div>
        {isLoading ? (
          <div className="h-7 w-16 animate-pulse rounded-sm bg-white/10" />
        ) : (
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
        )}
        <div className="mt-1 text-sm text-white/60">{label}</div>
        {caption ? (
          <div className="mt-2 text-xs text-white/40">{caption}</div>
        ) : null}
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const t = useT();
  const session = useRequireAuth();
  const enabled = session.ready && session.authenticated;

  const dashboard = useDashboardData(enabled);
  const credits = useCreditsBalance();
  const agentSandboxes = useAgents();
  const apps = useApps();
  const apiKeys = useApiKeys();
  const referral = useDashboardReferralMe();

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
            "Manage your Eliza agent instances, API access, billing, and earnings from the Eliza Cloud dashboard.",
        })}
      />
    </Helmet>
  );

  if (!session.ready) {
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
  }

  const agents = dashboard.data?.agents ?? [];
  const userName = dashboard.data?.user?.name ?? null;
  const creditBalance =
    typeof credits.data?.balance === "number" ? credits.data.balance : null;
  const formattedBalance = formatBalance(creditBalance);

  const agentSandboxList = agentSandboxes.data ?? [];
  const runningAgentSandboxes = agentSandboxList.filter(
    (a) => a.status === "running",
  ).length;

  const appList = apps.data ?? [];
  const deployedApps = appList.filter(
    (a) => a.deployment_status === "deployed",
  ).length;

  const apiKeyList = apiKeys.data ?? [];
  const activeKeys = apiKeyList.filter((k) => k.is_active).length;

  const referralCount = referral.referralMe?.total_referrals ?? null;

  return (
    <>
      {head}
      <DashboardPageWrapper>
        <DashboardPageContainer>
          <DashboardPageStack className="pt-4 md:pt-6">
            {/* Header */}
            <section className="flex flex-col gap-2">
              <p className="text-sm font-medium uppercase tracking-normal text-[#FF5800]">
                {t("cloud.dashboard.eyebrow", {
                  defaultValue: "elizaOS Platform / Eliza Cloud",
                })}
              </p>
              <h1 className="text-3xl font-semibold tracking-normal text-white md:text-4xl">
                {userName
                  ? t("cloud.dashboard.welcomeNamed", {
                      defaultValue: `Welcome back, ${userName}`,
                      name: userName,
                    })
                  : t("cloud.dashboard.welcome", {
                      defaultValue: "Welcome back",
                    })}
              </h1>
            </section>

            {/* Balance + Top-up */}
            <section className="grid gap-3 md:grid-cols-3">
              <Link
                to="/dashboard/billing"
                className={`${NEUTRAL_CARD} md:col-span-2`}
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-sm text-white/60">
                    <Wallet className="h-4 w-4" />
                    {t("cloud.dashboard.balance.label", {
                      defaultValue: "Credit balance",
                    })}
                  </span>
                  <ArrowRight className="h-4 w-4 text-white/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/70" />
                </div>
                <div>
                  {credits.isLoading ? (
                    <div className="h-10 w-32 animate-pulse rounded-sm bg-white/10" />
                  ) : (
                    <div className="text-4xl font-semibold tracking-tight text-white">
                      {formattedBalance}
                    </div>
                  )}
                  <div className="mt-2 text-xs text-white/40">
                    {t("cloud.dashboard.balance.caption", {
                      defaultValue:
                        "Used for hosted inference and runtime time",
                    })}
                  </div>
                </div>
              </Link>

              <Link to="/dashboard/billing" className={ACCENT_CARD}>
                <div className="flex items-center justify-between">
                  <CreditCard className="h-5 w-5" />
                  <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </div>
                <div>
                  <div className="text-lg font-semibold">
                    {t("cloud.dashboard.topup.title", {
                      defaultValue: "Add credits",
                    })}
                  </div>
                  <div className="mt-1 text-sm text-black/70">
                    {t("cloud.dashboard.topup.subtitle", {
                      defaultValue: "Top up to keep agents running",
                    })}
                  </div>
                </div>
              </Link>
            </section>

            {/* Stats row */}
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                to="/dashboard/my-agents"
                icon={<span className="text-base">●</span>}
                label={t("cloud.dashboard.stats.agents", {
                  defaultValue: "Agents",
                })}
                value={agents.length}
                isLoading={dashboard.isLoading}
              />
              <StatCard
                to="/dashboard/agents"
                icon={<Server className="h-5 w-5" />}
                label={t("cloud.dashboard.stats.containers", {
                  defaultValue: "Instances running",
                })}
                value={runningAgentSandboxes}
                caption={
                  agentSandboxList.length > 0
                    ? `of ${agentSandboxList.length} total`
                    : undefined
                }
                isLoading={agentSandboxes.isLoading}
              />
              <StatCard
                to="/dashboard/apps"
                icon={<Store className="h-5 w-5" />}
                label={t("cloud.dashboard.stats.apps", {
                  defaultValue: "Apps deployed",
                })}
                value={deployedApps}
                caption={
                  appList.length > 0 ? `of ${appList.length} total` : undefined
                }
                isLoading={apps.isLoading}
              />
              <StatCard
                to="/dashboard/api-keys"
                icon={<KeyRound className="h-5 w-5" />}
                label={t("cloud.dashboard.stats.keys", {
                  defaultValue: "Active API keys",
                })}
                value={activeKeys}
                isLoading={apiKeys.isLoading}
              />
            </section>

            {/* Agents grid */}
            <section>
              {dashboard.isLoading ? (
                <AgentsSectionSkeleton />
              ) : (
                <AgentsSection agents={agents} />
              )}
            </section>

            {/* Footer row */}
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Link to="/dashboard/earnings" className={NEUTRAL_CARD}>
                <div className="flex items-center justify-between">
                  <Wallet className="h-5 w-5 text-white/70" />
                  <ArrowRight className="h-4 w-4 text-white/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/70" />
                </div>
                <div>
                  <div className="text-base font-semibold">
                    {t("cloud.dashboard.earnings.title", {
                      defaultValue: "Earnings",
                    })}
                  </div>
                  <div className="mt-1 text-sm text-white/60">
                    {t("cloud.dashboard.earnings.subtitle", {
                      defaultValue: "Track creator revenue and redeem",
                    })}
                  </div>
                </div>
              </Link>

              <Link to="/dashboard/affiliates" className={NEUTRAL_CARD}>
                <div className="flex items-center justify-between">
                  <Share2 className="h-5 w-5 text-white/70" />
                  <ArrowRight className="h-4 w-4 text-white/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/70" />
                </div>
                <div>
                  <div className="text-base font-semibold">
                    {t("cloud.dashboard.referrals.title", {
                      defaultValue: "Referrals",
                    })}
                  </div>
                  <div className="mt-1 text-sm text-white/60">
                    {referral.loadingReferral
                      ? t("cloud.dashboard.referrals.loading", {
                          defaultValue: "Loading...",
                        })
                      : referralCount !== null
                        ? t("cloud.dashboard.referrals.count", {
                            defaultValue: `${referralCount} referred`,
                            count: referralCount,
                          })
                        : t("cloud.dashboard.referrals.subtitle", {
                            defaultValue: "Invite and earn credits",
                          })}
                  </div>
                </div>
              </Link>

              <a
                href="/docs"
                target="_blank"
                rel="noopener noreferrer"
                className={NEUTRAL_CARD}
              >
                <div className="flex items-center justify-between">
                  <BookOpen className="h-5 w-5 text-white/70" />
                  <ArrowRight className="h-4 w-4 text-white/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white/70" />
                </div>
                <div>
                  <div className="text-base font-semibold">
                    {t("cloud.dashboard.docs.title", {
                      defaultValue: "Docs & API",
                    })}
                  </div>
                  <div className="mt-1 text-sm text-white/60">
                    {t("cloud.dashboard.docs.subtitle", {
                      defaultValue: "Reference, guides, and SDKs",
                    })}
                  </div>
                </div>
              </a>
            </section>

            {/* Sidebar nudge — link out to deeper surfaces */}
            <section className="flex flex-wrap items-center gap-2 pb-4">
              <span className="text-xs text-white/40">
                {t("cloud.dashboard.deepLinks.label", {
                  defaultValue: "More:",
                })}
              </span>
              <BrandButton
                asChild
                variant="outline"
                size="sm"
                className="h-7 text-xs"
              >
                <Link to="/dashboard/analytics">Analytics</Link>
              </BrandButton>
              <BrandButton
                asChild
                variant="outline"
                size="sm"
                className="h-7 text-xs"
              >
                <Link to="/dashboard/security">Security</Link>
              </BrandButton>
              <BrandButton
                asChild
                variant="outline"
                size="sm"
                className="h-7 text-xs"
              >
                <Link to="/dashboard/settings">Settings</Link>
              </BrandButton>
            </section>
          </DashboardPageStack>
        </DashboardPageContainer>
      </DashboardPageWrapper>
    </>
  );
}
