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
 *    invoice) navigate the memory history; nesting a router inside an existing
 *    one is avoided.
 *  - **QueryClientProvider:** the shared cloud {@link queryClient}. Re-providing
 *    the same client under an existing provider is a harmless no-op.
 *  - **CloudI18nProvider:** so `useCloudT()` resolves.
 *  - **StewardAuthProvider:** the auth context the api-keys / account / billing
 *    gates read. It lazy-loads the heavy `@stwd/*` runtime only when a token is
 *    present (see `StewardAuthProvider`), so signed-out users pay nothing.
 *  - **PageHeaderProvider:** surfaces that call `useSetPageHeader` (api-keys,
 *    account, …) need an ancestor; the Settings view renders its own header, so
 *    the cloud page header is captured here and discarded — the body still
 *    renders its content.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter, useInRouterContext } from "react-router-dom";
import { PageHeaderProvider } from "../../cloud-ui";
import { queryClient } from "../lib/query-client";
import {
  CloudI18nProvider,
  resolveInitialCloudLang,
} from "../shell/CloudI18nProvider";
import { StewardAuthProvider } from "../shell/StewardProvider";

function MaybeRouter({ children }: { children: ReactNode }) {
  const inRouter = useInRouterContext();
  if (inRouter) return <>{children}</>;
  return <MemoryRouter>{children}</MemoryRouter>;
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
      <QueryClientProvider client={queryClient}>
        <CloudI18nProvider initialLang={resolveInitialCloudLang()}>
          <StewardAuthProvider>
            <PageHeaderProvider>{children}</PageHeaderProvider>
          </StewardAuthProvider>
        </CloudI18nProvider>
      </QueryClientProvider>
    </MaybeRouter>
  );
}
