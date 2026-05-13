import {
  DashboardRouteError,
  formatDashboardRouteErrorMessage,
  useRenderGuard,
} from "@elizaos/cloud-ui";
import {
  Component,
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
} from "react";
import { matchPath, Navigate, Route, Routes, useLocation } from "react-router-dom";
import RootLayout from "./RootLayout";

/**
 * `lazy()` + a `.preload()` shortcut so navigation links can warm a route
 * chunk on hover/focus before the user clicks. The factory closes over the
 * same dynamic-import promise React uses internally, so calling preload
 * primes the module cache without changing render behavior.
 */
type Preloadable<T extends ComponentType<unknown>> = LazyExoticComponent<T> & {
  preload: () => Promise<{ default: T }>;
};

type PreloadFn = () => Promise<unknown>;

type RoutePreload = {
  path: string;
  preload: PreloadFn;
};

function lazyWithPreload<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
): Preloadable<T> {
  const Component = lazy(factory) as Preloadable<T>;
  Component.preload = factory;
  return Component;
}

function preloadAll(...preloads: PreloadFn[]): PreloadFn {
  return () => Promise.all(preloads.map((preload) => preload())).then(() => undefined);
}

const Home = lazyWithPreload(() => import("./pages/page"));
const TermsOfService = lazyWithPreload(() => import("./pages/terms-of-service/page"));
const PrivacyPolicy = lazyWithPreload(() => import("./pages/privacy-policy/page"));
const SandboxProxy = lazyWithPreload(() => import("./pages/sandbox-proxy/page"));
const PublicChat = lazyWithPreload(() => import("./pages/chat/[characterRef]/page"));

const AuthSuccess = lazyWithPreload(() => import("./pages/auth/success/page"));
const AuthCliLogin = lazyWithPreload(() => import("./pages/auth/cli-login/page"));
const AuthError = lazyWithPreload(() => import("./pages/auth/error/page"));
const AuthEmailCallback = lazyWithPreload(() => import("./pages/auth/callback/email/page"));
const AppAuthAuthorize = lazyWithPreload(() => import("./pages/app-auth/authorize/page"));

const LoginLayout = lazyWithPreload(() => import("./pages/login/layout"));
const LoginPage = lazyWithPreload(() => import("./pages/login/page"));

const InviteAcceptLayout = lazyWithPreload(() => import("./pages/invite/accept/layout"));
const InviteAcceptPage = lazyWithPreload(() => import("./pages/invite/accept/page"));

const PaymentSuccessLayout = lazyWithPreload(() => import("./pages/payment/success/layout"));
const PaymentSuccessPage = lazyWithPreload(() => import("./pages/payment/success/page"));
const PaymentRequestPage = lazyWithPreload(() => import("./pages/payment/[paymentRequestId]/page"));
const AppChargePaymentLayout = lazyWithPreload(
  () => import("./pages/payment/app-charge/[appId]/[chargeId]/layout"),
);
const AppChargePaymentPage = lazyWithPreload(
  () => import("./pages/payment/app-charge/[appId]/[chargeId]/page"),
);
const SensitiveRequestPage = lazyWithPreload(
  () => import("./pages/sensitive-requests/[requestId]/page"),
);

const BlogIndex = lazyWithPreload(() => import("./pages/blog/page"));
const BlogPost = lazyWithPreload(() => import("./pages/blog/[slug]/page"));

const DocsRouter = lazyWithPreload(() => import("./docs/DocsRouter"));

const DashboardLayout = lazyWithPreload(() => import("./dashboard/DashboardLayout"));
const DashboardIndex = lazyWithPreload(() => import("./dashboard/Page"));

const AccountPage = lazyWithPreload(() => import("./dashboard/account/Page"));
const SettingsPage = lazyWithPreload(() => import("./dashboard/settings/Page"));
const BillingPage = lazyWithPreload(() => import("./dashboard/billing/Page"));
const BillingSuccessPage = lazyWithPreload(() => import("./dashboard/billing/success/Page"));

const AgentPage = lazyWithPreload(() => import("./dashboard/agents/Page"));
const AgentDetailPage = lazyWithPreload(() => import("./dashboard/agents/[id]/Page"));

const AppsPage = lazyWithPreload(() => import("./dashboard/apps/Page"));
const AppDetailPage = lazyWithPreload(() => import("./dashboard/apps/[id]/Page"));

const MyAgentsPage = lazyWithPreload(() => import("./dashboard/my-agents/Page"));
const ApiKeysPage = lazyWithPreload(() => import("./dashboard/api-keys/Page"));
const McpsPage = lazyWithPreload(() => import("./dashboard/mcps/Page"));
const VoicesPage = lazyWithPreload(() => import("./dashboard/voices/Page"));
const DocumentsPage = lazyWithPreload(() => import("./dashboard/documents/Page"));

const AnalyticsPage = lazyWithPreload(() => import("./dashboard/analytics/Page"));
const EarningsPage = lazyWithPreload(() => import("./dashboard/earnings/Page"));
const AffiliatesPage = lazyWithPreload(() => import("./dashboard/affiliates/Page"));
const InvoiceDetailPage = lazyWithPreload(() => import("./dashboard/invoices/[id]/Page"));

const ImagePage = lazyWithPreload(() => import("./dashboard/image/Page"));
const VideoPage = lazyWithPreload(() => import("./dashboard/video/Page"));
const GalleryPage = lazyWithPreload(() => import("./dashboard/gallery/Page"));

const ContainersPage = lazyWithPreload(() => import("./dashboard/containers/Page"));
const ContainerDetailPage = lazyWithPreload(() => import("./dashboard/containers/[id]/Page"));
const ContainerAgentDetailPage = lazyWithPreload(
  () => import("./dashboard/containers/agents/[id]/Page"),
);

const ChatBuildLayout = lazyWithPreload(() => import("./dashboard/chat-build/Layout"));
const ChatPage = lazyWithPreload(() => import("./dashboard/chat/Page"));

const ApiExplorerLayout = lazyWithPreload(() => import("./dashboard/api-explorer/Layout"));
const ApiExplorerPage = lazyWithPreload(() => import("./dashboard/api-explorer/Page"));

const AdminLayout = lazyWithPreload(() => import("./dashboard/admin/Layout"));
const AdminPage = lazyWithPreload(() => import("./dashboard/admin/Page"));
const AdminInfrastructurePage = lazyWithPreload(
  () => import("./dashboard/admin/infrastructure/Page"),
);
const AdminMetricsPage = lazyWithPreload(() => import("./dashboard/admin/metrics/Page"));
const AdminRedemptionsPage = lazyWithPreload(() => import("./dashboard/admin/redemptions/Page"));

/**
 * Map of React Router path pattern → preload function. Hovering or focusing
 * a link with an `href` matching one of these routes warms the matched branch
 * chunks before navigation. Static routes must stay before dynamic siblings
 * because `/dashboard/apps/:id` also matches `/dashboard/apps/create`.
 */
const PRELOAD_ROUTES: ReadonlyArray<RoutePreload> = [
  {
    path: "/dashboard/admin/infrastructure",
    preload: preloadAll(
      DashboardLayout.preload,
      AdminLayout.preload,
      AdminInfrastructurePage.preload,
    ),
  },
  {
    path: "/dashboard/admin/metrics",
    preload: preloadAll(DashboardLayout.preload, AdminLayout.preload, AdminMetricsPage.preload),
  },
  {
    path: "/dashboard/admin/redemptions",
    preload: preloadAll(DashboardLayout.preload, AdminLayout.preload, AdminRedemptionsPage.preload),
  },
  {
    path: "/dashboard/admin",
    preload: preloadAll(DashboardLayout.preload, AdminLayout.preload, AdminPage.preload),
  },
  {
    path: "/dashboard/api-explorer",
    preload: preloadAll(
      DashboardLayout.preload,
      ApiExplorerLayout.preload,
      ApiExplorerPage.preload,
    ),
  },
  {
    path: "/dashboard/api-keys",
    preload: preloadAll(DashboardLayout.preload, ApiKeysPage.preload),
  },
  {
    path: "/dashboard/apps/create",
    preload: preloadAll(DashboardLayout.preload, AppsPage.preload),
  },
  {
    path: "/dashboard/apps/:id",
    preload: preloadAll(DashboardLayout.preload, AppDetailPage.preload),
  },
  { path: "/dashboard/apps", preload: preloadAll(DashboardLayout.preload, AppsPage.preload) },
  {
    path: "/dashboard/billing/success",
    preload: preloadAll(DashboardLayout.preload, BillingSuccessPage.preload),
  },
  { path: "/dashboard/billing", preload: preloadAll(DashboardLayout.preload, BillingPage.preload) },
  {
    path: "/dashboard/chat",
    preload: preloadAll(DashboardLayout.preload, ChatBuildLayout.preload, ChatPage.preload),
  },
  {
    path: "/dashboard/containers/agents/:id",
    preload: preloadAll(DashboardLayout.preload, ContainerAgentDetailPage.preload),
  },
  {
    path: "/dashboard/containers/:id",
    preload: preloadAll(DashboardLayout.preload, ContainerDetailPage.preload),
  },
  {
    path: "/dashboard/containers",
    preload: preloadAll(DashboardLayout.preload, ContainersPage.preload),
  },
  {
    path: "/dashboard/agents/:id",
    preload: preloadAll(DashboardLayout.preload, AgentDetailPage.preload),
  },
  { path: "/dashboard/agents", preload: preloadAll(DashboardLayout.preload, AgentPage.preload) },
  {
    path: "/dashboard/affiliates",
    preload: preloadAll(DashboardLayout.preload, AffiliatesPage.preload),
  },
  {
    path: "/dashboard/analytics",
    preload: preloadAll(DashboardLayout.preload, AnalyticsPage.preload),
  },
  {
    path: "/dashboard/earnings",
    preload: preloadAll(DashboardLayout.preload, EarningsPage.preload),
  },
  { path: "/dashboard/gallery", preload: preloadAll(DashboardLayout.preload, GalleryPage.preload) },
  { path: "/dashboard/image", preload: preloadAll(DashboardLayout.preload, ImagePage.preload) },
  {
    path: "/dashboard/invoices/:id",
    preload: preloadAll(DashboardLayout.preload, InvoiceDetailPage.preload),
  },
  {
    path: "/dashboard/documents",
    preload: preloadAll(DashboardLayout.preload, DocumentsPage.preload),
  },
  { path: "/dashboard/mcps", preload: preloadAll(DashboardLayout.preload, McpsPage.preload) },
  {
    path: "/dashboard/my-agents",
    preload: preloadAll(DashboardLayout.preload, MyAgentsPage.preload),
  },
  {
    path: "/dashboard/settings",
    preload: preloadAll(DashboardLayout.preload, SettingsPage.preload),
  },
  { path: "/dashboard/account", preload: preloadAll(DashboardLayout.preload, AccountPage.preload) },
  { path: "/dashboard/video", preload: preloadAll(DashboardLayout.preload, VideoPage.preload) },
  { path: "/dashboard/voices", preload: preloadAll(DashboardLayout.preload, VoicesPage.preload) },
  { path: "/dashboard", preload: preloadAll(DashboardLayout.preload, DashboardIndex.preload) },
  { path: "/blog/:slug", preload: BlogPost.preload },
  { path: "/blog", preload: BlogIndex.preload },
  { path: "/docs", preload: DocsRouter.preload },
  { path: "/docs/*", preload: DocsRouter.preload },
  { path: "/login", preload: preloadAll(LoginLayout.preload, LoginPage.preload) },
  {
    path: "/invite/accept",
    preload: preloadAll(InviteAcceptLayout.preload, InviteAcceptPage.preload),
  },
  {
    path: "/payment/app-charge/:appId/:chargeId",
    preload: preloadAll(AppChargePaymentLayout.preload, AppChargePaymentPage.preload),
  },
  {
    path: "/payment/success",
    preload: preloadAll(PaymentSuccessLayout.preload, PaymentSuccessPage.preload),
  },
  { path: "/payment/:paymentRequestId", preload: PaymentRequestPage.preload },
  { path: "/sensitive-requests/:requestId", preload: SensitiveRequestPage.preload },
  { path: "/auth/success", preload: AuthSuccess.preload },
  { path: "/auth/cli-login", preload: AuthCliLogin.preload },
  { path: "/auth/error", preload: AuthError.preload },
  { path: "/auth/callback/email", preload: AuthEmailCallback.preload },
  { path: "/app-auth/authorize", preload: AppAuthAuthorize.preload },
  { path: "/chat/:characterRef", preload: PublicChat.preload },
  { path: "/sandbox-proxy", preload: SandboxProxy.preload },
  { path: "/privacy-policy", preload: PrivacyPolicy.preload },
  { path: "/terms-of-service", preload: TermsOfService.preload },
];

function findPreloadForHref(href: string | null | undefined): (() => Promise<unknown>) | null {
  if (!href) return null;
  const isRootRelative = href.startsWith("/");
  const isAbsolute = href.startsWith("http://") || href.startsWith("https://");
  if (!isRootRelative && !isAbsolute) return null;

  let pathname: string;
  try {
    const parsed = new URL(href, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    pathname = parsed.pathname.replace(/\/$/, "") || "/";
  } catch {
    return null;
  }

  for (const { path, preload } of PRELOAD_ROUTES) {
    if (matchPath({ path, end: true }, pathname)) {
      return preload;
    }
  }
  return null;
}

/**
 * Listens at the document root for hover/focus on internal links and warms
 * the matching route chunk. Using a delegated listener keeps this orthogonal
 * to whatever sidebar / link component renders the anchor — the only contract
 * is `<a href="/dashboard/...">`.
 */
function useLinkChunkPreload() {
  useEffect(() => {
    const seen = new WeakSet<HTMLAnchorElement>();

    function maybePreload(target: EventTarget | null) {
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || seen.has(anchor)) return;
      const href = anchor.getAttribute("href");
      const preload = findPreloadForHref(href);
      if (!preload) return;
      seen.add(anchor);
      preload().catch(() => {
        // Preload is best-effort. The real navigation will surface the error
        // again with proper Suspense boundaries.
        seen.delete(anchor);
      });
    }

    function onPointerOver(e: PointerEvent) {
      maybePreload(e.target);
    }
    function onFocusIn(e: FocusEvent) {
      maybePreload(e.target);
    }

    document.addEventListener("pointerover", onPointerOver, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);
}

/**
 * Lightweight transparent fallback used when a route chunk is in flight.
 * The header/footer/theme stay mounted because Suspense lives below
 * RootLayout, so this only fills the inner slot for a few hundred ms on
 * cold navigation. The dashboard supplies its own richer skeleton.
 */
function RouteChunkFallback() {
  return <div aria-busy="true" className="min-h-[40vh]" />;
}

/**
 * Wraps a lazy-loaded route component in the standard Suspense boundary.
 * Use this instead of repeating `<Suspense fallback={<RouteChunkFallback />}>` inline.
 */
function SuspenseRoute({ component: RouteComponent }: { component: ComponentType }) {
  return (
    <Suspense fallback={<RouteChunkFallback />}>
      <RouteComponent />
    </Suspense>
  );
}

function NotFound() {
  return (
    <div className="p-8 max-w-prose mx-auto text-sm text-neutral-400">
      <h1 className="text-lg font-semibold text-white mb-3">Not found</h1>
      <p>The page you requested doesn't exist.</p>
    </div>
  );
}

type RouteErrorBoundaryProps = {
  children: ReactNode;
  fallback: (error: unknown) => ReactNode;
  resetKey: string;
};

type RouteErrorBoundaryState = {
  error: unknown;
};

class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: RouteErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}

function DashboardRouteElement() {
  const location = useLocation();
  return (
    <RouteErrorBoundary
      resetKey={location.pathname}
      fallback={(error: unknown) => (
        <DashboardRouteError
          message={formatDashboardRouteErrorMessage(
            error instanceof Error ? error : typeof error === "string" ? error : undefined,
          )}
        />
      )}
    >
      <Suspense fallback={<RouteChunkFallback />}>
        <DashboardLayout />
      </Suspense>
    </RouteErrorBoundary>
  );
}

function LegacyBuildRedirect() {
  const location = useLocation();
  return <Navigate to={`/dashboard/chat${location.search}`} replace />;
}

function App() {
  useRenderGuard("CloudFrontendApp");
  useLinkChunkPreload();
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<SuspenseRoute component={Home} />} />
        <Route path="terms-of-service" element={<SuspenseRoute component={TermsOfService} />} />
        <Route path="privacy-policy" element={<SuspenseRoute component={PrivacyPolicy} />} />
        <Route path="sandbox-proxy" element={<SuspenseRoute component={SandboxProxy} />} />
        <Route path="chat/:characterRef" element={<SuspenseRoute component={PublicChat} />} />

        <Route path="auth/success" element={<SuspenseRoute component={AuthSuccess} />} />
        <Route path="auth/cli-login" element={<SuspenseRoute component={AuthCliLogin} />} />
        <Route path="auth/error" element={<SuspenseRoute component={AuthError} />} />
        <Route
          path="auth/callback/email"
          element={<SuspenseRoute component={AuthEmailCallback} />}
        />
        <Route path="app-auth/authorize" element={<SuspenseRoute component={AppAuthAuthorize} />} />

        <Route path="login" element={<SuspenseRoute component={LoginLayout} />}>
          <Route index element={<SuspenseRoute component={LoginPage} />} />
        </Route>

        <Route path="invite/accept" element={<SuspenseRoute component={InviteAcceptLayout} />}>
          <Route index element={<SuspenseRoute component={InviteAcceptPage} />} />
        </Route>

        <Route
          path="payment/app-charge/:appId/:chargeId"
          element={<SuspenseRoute component={AppChargePaymentLayout} />}
        >
          <Route index element={<SuspenseRoute component={AppChargePaymentPage} />} />
        </Route>
        <Route
          path="payment/:paymentRequestId"
          element={<SuspenseRoute component={PaymentRequestPage} />}
        />

        <Route path="payment/success" element={<SuspenseRoute component={PaymentSuccessLayout} />}>
          <Route index element={<SuspenseRoute component={PaymentSuccessPage} />} />
        </Route>
        <Route
          path="sensitive-requests/:requestId"
          element={<SuspenseRoute component={SensitiveRequestPage} />}
        />

        <Route path="blog">
          <Route index element={<SuspenseRoute component={BlogIndex} />} />
          <Route path=":slug" element={<SuspenseRoute component={BlogPost} />} />
        </Route>

        <Route path="docs/*" element={<SuspenseRoute component={DocsRouter} />} />

        {/*
         * Dashboard subtree. Suspense for the layout itself stays here, but
         * the inner per-page `<Outlet />` gets its own Suspense inside
         * DashboardLayout so the sidebar/header don't unmount when the user
         * jumps between dashboard tabs.
         */}
        <Route path="dashboard/build/*" element={<LegacyBuildRedirect />} />

        <Route path="dashboard" element={<DashboardRouteElement />}>
          <Route index element={<DashboardIndex />} />

          <Route path="account" element={<AccountPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="billing/success" element={<BillingSuccessPage />} />

          <Route path="agents" element={<AgentPage />} />
          <Route path="agents/:id" element={<AgentDetailPage />} />

          <Route path="apps" element={<AppsPage />} />
          <Route path="apps/create" element={<Navigate to="/dashboard/apps" replace />} />
          <Route path="apps/:id" element={<AppDetailPage />} />

          <Route path="my-agents" element={<MyAgentsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="mcps" element={<McpsPage />} />
          <Route path="voices" element={<VoicesPage />} />
          <Route path="documents" element={<DocumentsPage />} />

          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="earnings" element={<EarningsPage />} />
          <Route path="affiliates" element={<AffiliatesPage />} />
          <Route path="invoices/:id" element={<InvoiceDetailPage />} />

          <Route path="image" element={<ImagePage />} />
          <Route path="video" element={<VideoPage />} />
          <Route path="gallery" element={<GalleryPage />} />

          <Route path="containers" element={<ContainersPage />} />
          <Route path="containers/:id" element={<ContainerDetailPage />} />
          <Route path="containers/agents/:id" element={<ContainerAgentDetailPage />} />

          <Route element={<ChatBuildLayout />}>
            <Route path="chat" element={<ChatPage />} />
          </Route>

          <Route path="api-explorer" element={<ApiExplorerLayout />}>
            <Route index element={<ApiExplorerPage />} />
          </Route>

          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<AdminPage />} />
            <Route path="infrastructure" element={<AdminInfrastructurePage />} />
            <Route path="metrics" element={<AdminMetricsPage />} />
            <Route path="redemptions" element={<AdminRedemptionsPage />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default App;
