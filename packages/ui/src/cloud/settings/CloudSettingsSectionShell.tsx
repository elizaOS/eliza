/**
 * Provider shell that makes any lifted cloud body mount as a zero-arg in-app
 * Settings section.
 *
 * Cloud bodies (`AccountSurface`, `ApiKeysSurface`, `BillingSectionBody`, …)
 * were written to render inside the web-only {@link CloudRouterShell}, which
 * supplies a React-Query client, the cloud i18n context, a Steward auth context,
 * and (for the surfaces that set a page header) a `PageHeaderProvider` — wrapped
 * in a `BrowserRouter`. The Settings view, however, renders registry sections
 * inside the tab/view app's catch-all, where the per-route Steward provider is
 * NOT applied, and on native there is no router/query/i18n at all.
 *
 * This shell re-establishes that exact stack around the body so a section works
 * identically on web and native:
 *
 *  - **Router:** only a fallback `MemoryRouter` when no router context exists
 *    ({@link useInRouterContext}). Bodies that call `useNavigate` (billing →
 *    invoice) navigate the memory history; that fallback mounts the canonical
 *    invoice-detail route registered by the billing domain. Nesting a router
 *    inside an existing one is avoided.
 *  - **QueryClientProvider:** the shared cloud {@link queryClient}. Re-providing
 *    the same client under an existing provider is a harmless no-op.
 *  - **CloudI18nProvider:** so `useCloudT()` resolves.
 *  - **StewardAuthProvider:** the auth context the api-keys / account / billing
 *    gates read. It lazy-loads the heavy `@stwd/*` runtime only when a token is
 *    present (see `StewardAuthProvider`), so signed-out users pay nothing.
 *  - **PageHeaderProvider:** surfaces that call `useSetPageHeader` (api-keys,
 *    account, …) need an ancestor. The Settings view owns the title, while this
 *    shell renders any contextual header actions published by the cloud body.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { type ComponentType, type ReactNode, Suspense } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useInRouterContext,
} from "react-router-dom";
import {
  PageHeaderProvider,
  usePageHeader,
} from "../../cloud-ui/components/layout";
import "../billing/routes";
import { queryClient } from "../lib/query-client";
import {
  CloudI18nProvider,
  resolveInitialCloudLang,
} from "../shell/CloudI18nProvider";
import { getCloudRoute } from "../shell/cloud-route-registry";
import { StewardAuthProvider } from "../shell/StewardProvider";

const BILLING_INVOICE_ROUTE_PATH = "cloud/invoices/:id";

function SettingsSectionProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CloudI18nProvider initialLang={resolveInitialCloudLang()}>
        <StewardAuthProvider>
          <PageHeaderProvider>{children}</PageHeaderProvider>
        </StewardAuthProvider>
      </CloudI18nProvider>
    </QueryClientProvider>
  );
}

function SettingsMemoryRoutes({ children }: { children: ReactNode }) {
  const invoiceRoute = getCloudRoute(BILLING_INVOICE_ROUTE_PATH);
  if (!invoiceRoute) {
    throw new Error(
      `Canonical Cloud route "${BILLING_INVOICE_ROUTE_PATH}" is not registered`,
    );
  }
  const InvoiceDetailRoute = invoiceRoute.element as ComponentType;

  return (
    <Routes>
      <Route
        path={`/${invoiceRoute.path}`}
        element={
          <Suspense
            fallback={
              <div
                aria-label="Loading invoice"
                aria-live="polite"
                role="status"
              />
            }
          >
            <InvoiceDetailRoute />
          </Suspense>
        }
      />
      <Route path="*" element={children} />
    </Routes>
  );
}

function MaybeRouter({ children }: { children: ReactNode }) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return <SettingsSectionProviders>{children}</SettingsSectionProviders>;
  }
  return (
    <MemoryRouter>
      <SettingsSectionProviders>
        <SettingsMemoryRoutes>{children}</SettingsMemoryRoutes>
      </SettingsSectionProviders>
    </MemoryRouter>
  );
}

function SettingsSectionHeaderActions() {
  const { pageInfo } = usePageHeader();

  if (pageInfo?.actions == null) return null;

  return <div className="mb-4 flex justify-end">{pageInfo.actions}</div>;
}

/**
 * Wrap a cloud settings-section body in the full cloud provider stack. Use this
 * inside every zero-arg section component registered into the settings registry.
 */
export function CloudSettingsSectionShell({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <MaybeRouter>
      <SettingsSectionHeaderActions />
      {children}
    </MaybeRouter>
  );
}
