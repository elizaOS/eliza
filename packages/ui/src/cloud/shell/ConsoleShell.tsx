/**
 * Cloud console chrome: the old cloud-frontend dashboard layout (fixed left
 * sidebar + top bar + content region) rebuilt from the surviving
 * `@elizaos/ui/cloud-ui` layout kit and wrapped around every `dashboard/*`
 * cloud route by `CloudRouterShell`. Pages that call `useSetPageHeader` get
 * their title/actions surfaced in the top bar; pages that ship their own
 * header provider simply render their own (the inner provider shadows this
 * one — harmless).
 *
 * Navigation is react-router `Link`s (client-side, no full reloads); the
 * current section highlights by path prefix so detail pages (e.g.
 * `dashboard/agents/:id`) keep their parent lit.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import {
  BarChart3,
  Bot,
  Braces,
  Building2,
  CreditCard,
  Grid3x3,
  Home,
  KeyRound,
  Lock,
  Plug,
  Sparkles,
  TrendingUp,
  User,
  Workflow,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  DashboardHeader,
  DashboardShellLayout,
  DashboardSidebar,
  type DashboardSidebarItem,
  type DashboardSidebarLinkRenderProps,
  type DashboardSidebarSection,
  PageHeaderProvider,
  usePageHeader,
} from "../../cloud-ui/components/layout";
import { useRequireAuth } from "../lib/use-session-auth";

/** The console nav, in scan order: overview, run things, observe, money,
 * account plumbing. Every href is a registered standalone cloud route. */
const CONSOLE_NAV_SECTIONS: DashboardSidebarSection[] = [
  {
    items: [
      { id: "overview", label: "Overview", href: "/dashboard", icon: Home },
    ],
  },
  {
    title: "Run",
    items: [
      {
        id: "agents",
        label: "Instances",
        href: "/dashboard/agents",
        icon: Bot,
      },
      {
        id: "my-agents",
        label: "My Agents",
        href: "/dashboard/my-agents",
        icon: Sparkles,
      },
      { id: "apps", label: "Apps", href: "/dashboard/apps", icon: Grid3x3 },
      { id: "mcps", label: "MCPs", href: "/dashboard/mcps", icon: Workflow },
    ],
  },
  {
    title: "Observe",
    items: [
      {
        id: "analytics",
        label: "Analytics",
        href: "/dashboard/analytics",
        icon: BarChart3,
      },
      {
        id: "api-explorer",
        label: "API Explorer",
        href: "/dashboard/api-explorer",
        icon: Braces,
      },
    ],
  },
  {
    title: "Money",
    items: [
      {
        id: "billing",
        label: "Billing",
        href: "/dashboard/billing",
        icon: CreditCard,
      },
      {
        id: "api-keys",
        label: "API Keys",
        href: "/dashboard/api-keys",
        icon: KeyRound,
      },
      {
        id: "monetization",
        label: "Monetization",
        href: "/dashboard/monetization",
        icon: TrendingUp,
      },
    ],
  },
  {
    title: "Account",
    items: [
      {
        id: "connectors",
        label: "Connectors",
        href: "/dashboard/connectors",
        icon: Plug,
      },
      {
        id: "account",
        label: "Account",
        href: "/dashboard/account",
        icon: User,
      },
      {
        id: "security",
        label: "Security",
        href: "/dashboard/security",
        icon: Lock,
      },
      {
        id: "organization",
        label: "Organization",
        href: "/dashboard/organization",
        icon: Building2,
      },
    ],
  },
];

function renderRouterLink({
  href,
  className,
  style,
  children,
}: DashboardSidebarLinkRenderProps): ReactNode {
  return (
    <Link to={href} className={className} style={style}>
      {children}
    </Link>
  );
}

/** Prefix match so agent/app detail routes keep their parent item lit; the
 * Overview item stays exact so it doesn't light for every console page. */
function isItemActive(item: DashboardSidebarItem, activePath: string): boolean {
  if (item.href === "/dashboard") return activePath === "/dashboard";
  return activePath === item.href || activePath.startsWith(`${item.href}/`);
}

function ConsoleLogo(): ReactNode {
  return (
    <Link to="/dashboard" aria-label="Eliza Cloud overview">
      <img
        src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
        alt="elizacloud"
        className="h-6 w-auto"
      />
    </Link>
  );
}

/** Top bar wired to the captured page header (title + actions) and the
 * signed-in identity. Lives inside PageHeaderProvider. */
function ConsoleHeader({
  onToggleSidebar,
  email,
}: {
  onToggleSidebar: () => void;
  email: string | null;
}): React.JSX.Element {
  const { pageInfo } = usePageHeader();
  return (
    <DashboardHeader
      onToggleSidebar={onToggleSidebar}
      pageInfo={pageInfo}
      rightContent={
        email ? (
          <span className="hidden truncate text-xs text-white/62 md:inline">
            {email}
          </span>
        ) : undefined
      }
    />
  );
}

export function ConsoleShell({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const location = useLocation();
  const session = useRequireAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  return (
    <PageHeaderProvider>
      <DashboardShellLayout
        sidebar={
          <DashboardSidebar
            sections={CONSOLE_NAV_SECTIONS}
            activePath={location.pathname}
            authenticated={session.authenticated}
            isOpen={sidebarOpen}
            onToggle={toggleSidebar}
            renderLink={renderRouterLink}
            isItemActive={isItemActive}
            logo={<ConsoleLogo />}
            // The kit's own `md:static` loses the cascade in this bundle: Vite
            // emits per-chunk CSS and a later chunk re-declares `.fixed`, which
            // ties on specificity and wins on order. Pin the desktop layout.
            className="md:!static"
          />
        }
        header={
          <ConsoleHeader
            onToggleSidebar={toggleSidebar}
            email={session.user?.email ?? null}
          />
        }
      >
        {children}
      </DashboardShellLayout>
    </PageHeaderProvider>
  );
}
