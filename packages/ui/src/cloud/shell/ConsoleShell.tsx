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
import { type ReactNode, useCallback, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import {
  DashboardHeader,
  DashboardShellLayout,
  DashboardSidebar,
  type DashboardSidebarLinkRenderProps,
  type DashboardSidebarSection,
  PageHeaderProvider,
  usePageHeader,
} from "../../cloud-ui/components/layout";
import { useSessionAuth } from "../lib/use-session-auth";
import {
  CONSOLE_OVERVIEW_NAV_ITEM,
  CONSOLE_SURFACES,
} from "./console-surfaces";

/**
 * The console nav is one flat list so sidebar section labels never compete
 * with Account and Organization route labels. Specialist routes stay registered
 * for deep links but are not promoted into the default console chrome.
 */
const CONSOLE_NAV_SECTIONS: DashboardSidebarSection[] = [
  {
    items: [
      CONSOLE_OVERVIEW_NAV_ITEM,
      ...CONSOLE_SURFACES.map(({ id, label, href, icon }) => ({
        id,
        label,
        href,
        icon,
      })),
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
  const session = useSessionAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  // A dead session must SEND THE USER TO LOGIN, not render the console with
  // every query gated off — that state reads as a fake-empty account ("No
  // agents yet", balance "—") and is indistinguishable from real data loss
  // (#13709: expired staging session showed exactly that). returnTo brings
  // them straight back after re-auth.
  if (session.ready && !session.authenticated) {
    const returnTo = encodeURIComponent(
      `${location.pathname}${location.search}`,
    );
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

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
