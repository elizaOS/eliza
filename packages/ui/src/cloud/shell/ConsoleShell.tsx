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
import { ChevronDown, LogOut, UserRound } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  DashboardHeader,
  DashboardShellLayout,
  DashboardSidebar,
  type DashboardSidebarLinkRenderProps,
  type DashboardSidebarSection,
  PageHeaderProvider,
  usePageHeader,
} from "../../cloud-ui/components/layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useCreditsBalance } from "../instances/lib/data/credits";
import { formatUsd } from "../lib/format-usd";
import { hasHydratableStewardToken } from "../lib/steward-session";
import { useSessionAuth } from "../lib/use-session-auth";
import {
  CONSOLE_OVERVIEW_NAV_ITEM,
  CONSOLE_SURFACES,
} from "./console-surfaces";
import { clearStaleStewardSession } from "./StewardProviderShared";

/**
 * The console nav is one flat list so sidebar section labels never compete
 * with route labels. Specialist routes stay registered for deep links but are
 * not promoted into the default console chrome.
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

function subscribeToStewardTokenChanges(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", listener);
  window.addEventListener("steward-token-sync", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("steward-token-sync", listener);
  };
}

function readHydratableStewardTokenSnapshot(): boolean {
  return hasHydratableStewardToken();
}

function useHasHydratableStewardToken(): boolean {
  return useSyncExternalStore(
    subscribeToStewardTokenChanges,
    readHydratableStewardTokenSnapshot,
    () => false,
  );
}

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

/** Credits balance pill + the account dropdown (Account / Billing / Sign out) —
 * the console's only sign-out affordance, so it must always be reachable.
 * Sign-out uses the same hardened Steward teardown path as auth refresh and
 * 401 recovery, keeping token mirrors, cookies, and sync listeners aligned. */
function ConsoleUserMenu({
  email,
}: {
  email: string | null;
}): React.JSX.Element {
  const navigate = useNavigate();
  const credits = useCreditsBalance();
  const balance =
    typeof credits.data?.balance === "number" ? credits.data.balance : null;

  return (
    <div className="flex items-center gap-2">
      {balance !== null ? (
        <span className="hidden rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/80 md:inline">
          {formatUsd(balance)} credits
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={email ? `Account menu for ${email}` : "Account menu"}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-white/70 outline-none hover:bg-white/5 hover:text-white"
        >
          <UserRound className="h-3.5 w-3.5 md:hidden" aria-hidden />
          <span className="hidden max-w-[160px] truncate md:inline">
            {email ?? "Account"}
          </span>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onSelect={() => navigate("/dashboard/account")}>
            Account
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/dashboard/billing")}>
            Billing
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-red-400"
            onSelect={() => {
              clearStaleStewardSession();
              navigate("/login", { replace: true });
            }}
          >
            <LogOut className="mr-2 h-3.5 w-3.5" aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
      rightContent={<ConsoleUserMenu email={email} />}
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
  const hasHydratableToken = useHasHydratableStewardToken();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  // A dead session must SEND THE USER TO LOGIN, not render the console with
  // every query gated off — that state reads as a fake-empty account ("No
  // agents yet", balance "—") and is indistinguishable from real data loss
  // (#13709: expired staging session showed exactly that). returnTo brings
  // them straight back after re-auth.
  if (session.ready && !session.authenticated) {
    // Post-OAuth hydration window: the login page persists the token and
    // navigates here BEFORE the auth provider consumes it, so for ~1-2s the
    // session reads ready-but-unauthenticated. Redirecting then bounces the
    // user back to the sign-in form — which reads as "login didn't work"
    // (nubs, #13406). Hold only for a non-expired, identity-bearing token:
    // expired/malformed tokens already read as signed-out in useSessionAuth and
    // must redirect immediately. The storage/sync subscription above makes a
    // provider clear transition re-render this branch into the login redirect.
    if (hasHydratableToken) {
      return (
        <div
          aria-busy="true"
          className="flex min-h-dvh items-center justify-center bg-bg text-sm text-muted"
        >
          Signing you in…
        </div>
      );
    }
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
