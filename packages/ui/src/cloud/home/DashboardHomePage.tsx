/**
 * Cloud console home mounted by the cloud router shell at `dashboard` — the
 * authenticated landing for apex control-plane hosts (elizacloud.ai), where
 * the agent app never mounts (see `AppCatchAllRoute`). One screen answers
 * "where is everything": the org credit balance with an add-funds path, and a
 * directory card for every console surface (agents, apps, analytics, billing,
 * API keys, monetization, connectors, account, security, organization). Cards
 * navigate to the standalone `dashboard/*` routes, so the whole console is
 * reachable from here without ever entering the agent app.
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bot,
  Braces,
  Building2,
  CreditCard,
  Grid3x3,
  KeyRound,
  Lock,
  Plug,
  Sparkles,
  TrendingUp,
  User,
  Workflow,
} from "lucide-react";
import { Link } from "react-router-dom";
import { DashboardLoadingState } from "../../cloud-ui/components/dashboard/route-placeholders";
import { useSetPageHeader } from "../../cloud-ui/components/layout";
import { useCreditsBalance } from "../instances/lib/data/credits";
import { useDocumentTitle } from "../lib/use-document-title";
import { useRequireAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";

interface ConsoleSurface {
  to: string;
  icon: LucideIcon;
  titleKey: string;
  titleDefault: string;
  descKey: string;
  descDefault: string;
}

/**
 * Every standalone console surface, in scan order: run things first (agents /
 * apps), then measure (analytics / explorer / MCPs), then money (billing /
 * keys / monetization), then account plumbing.
 */
const CONSOLE_SURFACES: ReadonlyArray<ConsoleSurface> = [
  {
    to: "/dashboard/agents",
    icon: Bot,
    titleKey: "cloud.home.agents",
    titleDefault: "Instances",
    descKey: "cloud.home.agentsDesc",
    descDefault: "Hosted agents: create, wake, sleep, logs.",
  },
  {
    to: "/dashboard/my-agents",
    icon: Sparkles,
    titleKey: "cloud.home.myAgents",
    titleDefault: "My Agents",
    descKey: "cloud.home.myAgentsDesc",
    descDefault: "Character library and agent console.",
  },
  {
    to: "/dashboard/apps",
    icon: Grid3x3,
    titleKey: "cloud.home.apps",
    titleDefault: "Apps",
    descKey: "cloud.home.appsDesc",
    descDefault: "Hosted apps: monetization, domains, users.",
  },
  {
    to: "/dashboard/analytics",
    icon: BarChart3,
    titleKey: "cloud.home.analytics",
    titleDefault: "Analytics",
    descKey: "cloud.home.analyticsDesc",
    descDefault: "Usage, cost, and success-rate trends.",
  },
  {
    to: "/dashboard/api-explorer",
    icon: Braces,
    titleKey: "cloud.home.apiExplorer",
    titleDefault: "API Explorer",
    descKey: "cloud.home.apiExplorerDesc",
    descDefault: "Try models and media generation live.",
  },
  {
    to: "/dashboard/mcps",
    icon: Workflow,
    titleKey: "cloud.home.mcps",
    titleDefault: "MCPs",
    descKey: "cloud.home.mcpsDesc",
    descDefault: "Hosted MCP servers for your agents.",
  },
  {
    to: "/dashboard/billing",
    icon: CreditCard,
    titleKey: "cloud.home.billing",
    titleDefault: "Billing",
    descKey: "cloud.home.billingDesc",
    descDefault: "Add funds, payment methods, invoices.",
  },
  {
    to: "/dashboard/api-keys",
    icon: KeyRound,
    titleKey: "cloud.home.apiKeys",
    titleDefault: "API Keys",
    descKey: "cloud.home.apiKeysDesc",
    descDefault: "Create and revoke inference API keys.",
  },
  {
    to: "/dashboard/monetization",
    icon: TrendingUp,
    titleKey: "cloud.home.monetization",
    titleDefault: "Monetization",
    descKey: "cloud.home.monetizationDesc",
    descDefault: "Earnings, redemptions, and affiliates.",
  },
  {
    to: "/dashboard/connectors",
    icon: Plug,
    titleKey: "cloud.home.connectors",
    titleDefault: "Connectors",
    descKey: "cloud.home.connectorsDesc",
    descDefault: "Discord, Telegram, Google, and more.",
  },
  {
    to: "/dashboard/account",
    icon: User,
    titleKey: "cloud.home.account",
    titleDefault: "Account",
    descKey: "cloud.home.accountDesc",
    descDefault: "Profile, email, and identity.",
  },
  {
    to: "/dashboard/security",
    icon: Lock,
    titleKey: "cloud.home.security",
    titleDefault: "Security",
    descKey: "cloud.home.securityDesc",
    descDefault: "Sessions, privacy, and audit log.",
  },
  {
    to: "/dashboard/organization",
    icon: Building2,
    titleKey: "cloud.home.organization",
    titleDefault: "Organization",
    descKey: "cloud.home.organizationDesc",
    descDefault: "Members, credentials, and invites.",
  },
];

function SurfaceCard({ surface }: { surface: ConsoleSurface }) {
  const t = useCloudT();
  const Icon = surface.icon;
  return (
    <Link
      to={surface.to}
      className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-4 transition-colors hover:border-accent/40 hover:bg-surface"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-5 text-txt-strong">
          {t(surface.titleKey, { defaultValue: surface.titleDefault })}
        </span>
        <span className="truncate text-xs leading-relaxed text-muted">
          {t(surface.descKey, { defaultValue: surface.descDefault })}
        </span>
      </span>
    </Link>
  );
}

/**
 * Balance hero. Three distinguishable states per the UI three-state rule:
 * loading (aria-busy em dash), error (designed "unavailable" text — never a
 * fabricated $0), and the live balance with the add-funds path next to it.
 */
function BalanceCard() {
  const t = useCloudT();
  const credits = useCreditsBalance();
  const balance =
    typeof credits.data?.balance === "number" ? credits.data.balance : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card px-5 py-5">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-muted">
          {t("cloud.home.creditsAvailable", {
            defaultValue: "Credits available",
          })}
        </span>
        {credits.isError ? (
          <span className="text-sm text-danger">
            {t("cloud.home.balanceUnavailable", {
              defaultValue: "Balance unavailable — retry shortly.",
            })}
          </span>
        ) : (
          <span
            aria-busy={balance === null}
            className="text-2xl font-semibold text-txt-strong"
          >
            {balance === null ? "—" : `$${balance.toFixed(2)}`}
          </span>
        )}
      </div>
      <Link
        to="/dashboard/billing"
        className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/85"
      >
        {t("cloud.home.addFunds", { defaultValue: "Add funds" })}
      </Link>
    </div>
  );
}

export function DashboardHomePage() {
  const t = useCloudT();
  const session = useRequireAuth();
  useDocumentTitle(t("cloud.home.metaTitle", { defaultValue: "Dashboard" }));
  // Title renders in the console chrome's top bar (ConsoleShell captures it).
  useSetPageHeader({
    title: t("cloud.home.title", { defaultValue: "Overview" }),
    description: t("cloud.home.subtitle", {
      defaultValue: "Manage your agents, apps, credits, and keys.",
    }),
  });

  if (!session.ready) {
    return (
      <DashboardLoadingState
        label={t("cloud.home.loading", { defaultValue: "Loading dashboard" })}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <BalanceCard />
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CONSOLE_SURFACES.map((surface) => (
          <SurfaceCard key={surface.to} surface={surface} />
        ))}
      </div>
    </div>
  );
}

export default DashboardHomePage;
