/**
 * Native mount for the Eliza Cloud **Applications** dashboard.
 *
 * The web build renders the Applications surfaces through the top-level
 * {@link CloudRouterShell} `<BrowserRouter>` (one router for the whole apex
 * console). Native (Capacitor iOS/Android, Electrobun) has no such shell — the
 * renderer boots the tab/view `App` directly and the WebView origin fronts the
 * embedded LOCAL agent, not Eliza Cloud. So to surface the SAME Applications
 * components inside the native app we mount them here as a self-contained
 * subtree:
 *
 *  - a **`MemoryRouter`** (NOT `BrowserRouter`) seeded at `/cloud/apps`, so
 *    the pages' own `react-router` navigation (`/cloud/apps/:id?tab=…`,
 *    the create-redirect, the detail UUID guard) works without touching the
 *    host app's URL bar or the native deep-link router;
 *  - the cloud providers the pages expect — the shared cloud `QueryClient` and
 *    the cloud i18n context (same pair `CloudRouterShell` wraps its routes in);
 *  - a **native Steward auth context** fed from the stored Steward JWT
 *    (`localStorage[STEWARD_TOKEN_KEY]`), so `useSessionAuth()` resolves
 *    immediately to the signed-in user instead of waiting on the heavy
 *    `@stwd/*` runtime (which native never mounts — sign-in is the existing
 *    `launchStewardLogin` launcher, reached before this view).
 *
 * Before the first render we run the native Steward session refresh
 * ({@link refreshCloudStewardSession}) when the stored JWT is near expiry, so
 * the first `api<T>` call the pages make carries a fresh token rather than a
 * stale one. The cross-origin Cloud API transport itself lives in the
 * native-aware api-client (`../lib/api-client`); this component only owns the
 * mount + auth context, and changes nothing on web (the web build mounts the
 * pages via `CloudRouterShell`, never this file).
 */

import { logger } from "@elizaos/logger";
import {
  getStewardTabSessionAuthorityCoordinator,
  STEWARD_SESSION_CHANGE_EVENT,
  StewardSessionAuthorityError,
} from "@elizaos/shared/steward-session-client";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import {
  cloudTokenSecsRemaining,
  refreshCloudStewardSession,
} from "../../api/client-cloud";
import { PageHeaderProvider } from "../../cloud-ui/components/layout";
import { getBootConfig } from "../../config/boot-config";
import { decodeJwtPayload } from "../lib/jwt";
import { queryClient } from "../lib/query-client";
import {
  readStoredStewardToken,
  writeStoredStewardToken,
} from "../lib/steward-session";
import {
  CloudI18nProvider,
  resolveInitialCloudLang,
} from "../shell/CloudI18nProvider";
import {
  clearStaleStewardSession,
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
} from "../shell/StewardProviderShared";
import ApplicationDetailPage from "./ApplicationDetailPage";
import ApplicationsPage from "./ApplicationsPage";

/** Entry route the MemoryRouter is seeded at (the Applications list). */
const APPS_LIST_PATH = "/cloud/apps";

/**
 * A stored JWT with at least this many seconds of life left is fresh enough to
 * render against directly — no pre-render refresh. Below it (or already
 * expired) we attempt the native refresh first so the first call isn't stale.
 */
const PRE_RENDER_REFRESH_AHEAD_SECS = 120;

/**
 * Hard cap on how long the pre-render refresh may block the first paint. On
 * native the refresh is a cross-origin POST that can hang; if it doesn't settle
 * in time we render anyway (the stored token, the api-client's 401 self-heal,
 * and the periodic refresh in `useCloudState` remain the backstops).
 */
const PRE_RENDER_REFRESH_TIMEOUT_MS = 4_000;

/**
 * Absolute Steward refresh endpoint for the native target, derived from the
 * configured cloud API base. Mirrors `resolveStewardRefreshEndpoint` in
 * `state/useCloudState.ts`: an apex/web host normalizes to the `api.` host so
 * the refresh lands on the Cloud API origin (the WebView origin fronts the
 * local agent, never Eliza Cloud).
 */
function resolveNativeStewardRefreshEndpoint(): string | undefined {
  const cloudBase =
    getBootConfig().cloudApiBase?.trim() || "https://api.eliza.app";
  try {
    const url = new URL(cloudBase);
    const host = url.hostname.toLowerCase();
    const apiHost =
      host === "eliza.app" ||
      host === "www.eliza.app" ||
      host === "cloud.eliza.app"
        ? "api.eliza.app"
        : host;
    return `${url.protocol}//${apiHost}/api/auth/steward-refresh`;
  } catch {
    // error-policy:J3 unparseable cloud base — no custom refresh endpoint;
    // the refresh call uses its built-in default.
    return undefined;
  }
}

/**
 * Whether the stored Steward JWT should be refreshed before the first render.
 * Only a present-but-near-expiry JWT is worth refreshing: a comfortably-fresh
 * token needs nothing, and a missing token can't be refreshed on native (there
 * is no same-origin refresh cookie — sign-in is the launcher's job, upstream of
 * this view).
 */
function shouldRefreshBeforeRender(token: string | null): boolean {
  if (!token) return false;
  const secs = cloudTokenSecsRemaining(token);
  // Opaque/device-code token (no decodable `exp`) → nothing to refresh.
  if (secs === null) return false;
  return secs < PRE_RENDER_REFRESH_AHEAD_SECS;
}

/** Build the native Steward auth context value from a stored JWT (or null). */
function buildStewardAuthValue(token: string | null): LocalStewardAuthValue {
  const claims = token ? decodeJwtPayload(token) : null;
  const live = Boolean(
    claims && (!claims.exp || claims.exp * 1000 > Date.now()),
  );
  const identity = claims?.userId ?? claims?.sub ?? "";
  const user =
    live && identity
      ? {
          id: identity,
          email: claims?.email ?? null,
          walletAddress: claims?.address,
        }
      : null;
  return {
    isAuthenticated: user !== null,
    isLoading: false,
    user,
    session: token ? { token } : null,
    signOut: () => clearStaleStewardSession(),
    getToken: () => token,
    // Native never drives email verification through this context — sign-in is
    // the existing `launchStewardLogin` launcher. Present only to satisfy the
    // context shape; calling it is a programming error here.
    verifyEmailCallback: async (_token: string, _email: string) => {
      throw new Error(
        "Email verification is handled by the native sign-in flow, not the apps studio.",
      );
    },
  };
}

/**
 * Provide the cloud Steward auth context from the stored JWT, kept in sync with
 * token changes (refresh, sign-out, 401 self-heal) so `useSessionAuth()` tracks
 * the live session without the `@stwd/*` runtime.
 */
function NativeStewardAuthProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [session, setSession] = useState(() => ({
    token: readStoredStewardToken(),
  }));

  useEffect(() => {
    // A page can return after expiry without any change to the stored token.
    // Recompute validity without remounting its router or live forms.
    const sync = () => setSession({ token: readStoredStewardToken() });
    window.addEventListener("storage", sync);
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, sync);
    window.addEventListener("pageshow", sync);
    window.addEventListener("steward-token-sync", sync);
    window.addEventListener("steward-unauthorized", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, sync);
      window.removeEventListener("pageshow", sync);
      window.removeEventListener("steward-token-sync", sync);
      window.removeEventListener("steward-unauthorized", sync);
    };
  }, []);

  const value = buildStewardAuthValue(session.token);

  return (
    <LocalStewardAuthContext.Provider value={value}>
      {children}
    </LocalStewardAuthContext.Provider>
  );
}

/**
 * Cloud providers for the native Applications mount — the shared cloud
 * `QueryClient` + cloud i18n (the same pair `CloudRouterShell` wraps its web
 * routes in), plus the `PageHeaderProvider` the dashboard layout
 * (`DashboardRoutePage` → `useSetPageHeader`) requires. On web each dashboard
 * surface gets that header context from its own route wrapper; the native
 * studio is that wrapper here, so it provides one for both the list and detail.
 * Steward auth is provided separately (native context, no `@stwd/*` runtime).
 */
function NativeCloudProviders({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <CloudI18nProvider initialLang={resolveInitialCloudLang()}>
        <NativeStewardAuthProvider>
          <PageHeaderProvider>{children}</PageHeaderProvider>
        </NativeStewardAuthProvider>
      </CloudI18nProvider>
    </QueryClientProvider>
  );
}

/** Transparent fill while the pre-render refresh settles. */
function StudioBootFallback(): React.JSX.Element {
  return <div aria-busy="true" className="min-h-[40vh]" />;
}

/**
 * Opaque dark cloud surface for the native mount. The Applications pages are
 * authored against the cloud console's dark theme (`theme-cloud` tokens, white
 * text, `white/10` borders); on web `CloudRouterShell` mounts that surface
 * around every authenticated route (`theme-cloud min-h-dvh bg-surface
 * text-txt`). The native app shell instead renders registered pages over the
 * HOST app theme (light/orange), so without this wrapper the studio floods
 * with the host background and its white-on-dark text is unreadable. Sized to
 * fill the shell's flex slot and own its scrolling.
 */
function StudioSurface({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="theme-cloud flex h-full min-h-0 w-full flex-col overflow-y-auto bg-surface text-txt">
      {children}
    </div>
  );
}

/**
 * The Applications routes, mounted in a `MemoryRouter` seeded at the list. The
 * `create` path redirects to the list (parity with the web shell's
 * `dashboard/apps/create` redirect), the detail route's own UUID guard sends any
 * other non-UUID id back too, and any stray path (e.g. a cross-domain link that
 * isn't intercepted to the system browser) lands back on the list rather than a
 * blank screen.
 */
function ApplicationsRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/cloud/apps" element={<ApplicationsPage />} />
      <Route
        path="/cloud/apps/create"
        element={<Navigate to={APPS_LIST_PATH} replace />}
      />
      <Route path="/cloud/apps/:id" element={<ApplicationDetailPage />} />
      <Route path="*" element={<Navigate to={APPS_LIST_PATH} replace />} />
    </Routes>
  );
}

/**
 * Native Applications studio. Default export so the app-shell page loader can
 * mount it lazily (`registerAppShellPage({ id: "cloud-apps", … })`).
 */
export default function NativeAppsStudio(): React.JSX.Element {
  const [bootRevision, setBootRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    let hidden = false;
    let active: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      active?.abort();
      clearTimeout(timer);
    };
    const boot = () => {
      cancel();
      const lifetime = new AbortController();
      active = lifetime;
      // Only the initial mount waits behind the fallback. A page-return
      // refresh must preserve the live router, detail tab and unsaved inputs.
      let finished = false;
      const finish = () => {
        if (!disposed && !hidden && active === lifetime && !finished) {
          finished = true;
          // Re-render the local auth provider even if refresh failed without
          // changing the token: it may have expired while the request waited.
          setBootRevision((revision) => revision + 1);
        }
      };
      // The visible deadline does not release the session hold of an
      // unabortable native request/write; late work settles under cancellation.
      const deadline = setTimeout(() => {
        lifetime.abort();
        finish();
      }, PRE_RENDER_REFRESH_TIMEOUT_MS);
      timer = deadline;
      const refresh = async () => {
        const token = readStoredStewardToken()?.trim() ?? null;
        if (!shouldRefreshBeforeRender(token)) return;
        const coordinator = getStewardTabSessionAuthorityCoordinator();
        const expected = coordinator.readSnapshot();
        const cloudBase = getBootConfig().cloudApiBase;
        const endpoint = resolveNativeStewardRefreshEndpoint();
        await coordinator.runExclusive({
          kind: "refresh",
          signal: lifetime.signal,
          expectedToken: expected.token,
          expectedGeneration: expected.generation,
          expectedScope: expected.scope,
          timeoutMs: PRE_RENDER_REFRESH_TIMEOUT_MS,
          work: async (authority) => {
            const validate = () => {
              authority.revalidate();
              if (getBootConfig().cloudApiBase !== cloudBase)
                throw new StewardSessionAuthorityError(
                  "The Applications Cloud destination changed",
                  "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
                );
            };
            validate();
            const refreshed = await refreshCloudStewardSession({
              endpoint,
              authority,
            });
            validate();
            if (!refreshed?.token) return;
            await writeStoredStewardToken(refreshed.token, {
              authority,
              beforePublish: validate,
            });
            validate();
            window.dispatchEvent(new CustomEvent("steward-token-sync"));
          },
        });
      };
      void refresh()
        .catch((error) => {
          // error-policy:J4 retain the prior durable session on failed refresh;
          // expiry is rendered by the studio's existing signed-out/error gate.
          if (!lifetime.signal.aborted)
            logger.warn(
              { error },
              "[NativeAppsStudio] session refresh unavailable",
            );
        })
        .finally(() => {
          clearTimeout(deadline);
          finish();
        });
    };
    const hide = () => {
      hidden = true;
      cancel();
    };
    const show = () => {
      if (!hidden || disposed) return;
      hidden = false;
      boot();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    boot();
    return () => {
      disposed = true;
      cancel();
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, []);

  if (bootRevision === 0) {
    return (
      <StudioSurface>
        <StudioBootFallback />
      </StudioSurface>
    );
  }

  return (
    <StudioSurface>
      <NativeCloudProviders>
        <MemoryRouter initialEntries={[APPS_LIST_PATH]}>
          <Suspense fallback={<StudioBootFallback />}>
            <ApplicationsRoutes />
          </Suspense>
        </MemoryRouter>
      </NativeCloudProviders>
    </StudioSurface>
  );
}
