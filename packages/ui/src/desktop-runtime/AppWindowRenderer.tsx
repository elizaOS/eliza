/**
 * AppWindowRenderer — full-bleed renderer for `appWindow=1#/apps/<slug>` routes.
 *
 * Each Electrobun app window mounts exactly one of:
 *   1. an internal-tool tab component (plugins, skills, lifeops, …)
 *   2. a registered overlay app's Component (e.g. companion)
 *   3. a registry/catalog app viewer iframe (with postMessage auth handshake)
 *
 * The renderer never mounts the main shell (sidebars, header, chat panes).
 */

import {
  type JSX,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AppLaunchResult,
  type AppRunSummary,
  client,
  type RegistryAppInfo,
} from "../api";
import { listAppShellPages } from "../app-shell-registry";
import { findAppBySlug, getAppSlug } from "../components/apps/helpers";
import {
  getInternalToolAppDescriptors,
  getInternalToolAppTargetTab,
} from "../components/apps/internal-tool-apps";
import {
  getAllOverlayApps,
  getOverlayApp,
  isOverlayApp,
} from "../components/apps/overlay-app-registry";
import { useRegistryCatalog } from "../components/apps/useRegistryCatalog";
import {
  resolveEmbeddedViewerUrl,
  resolvePostMessageTargetOrigin,
  resolveViewerReadyEventType,
  shouldUseEmbeddedAppViewer,
} from "../components/apps/viewer-auth";
// Static imports for the internal-tool views. WHY not React.lazy: each of
// these is also statically imported by the main shell (App.tsx + tab
// routers + DetachedShellRoot), so a `lazy(() => import(...))` here would
// be folded back into the main chunk by Rollup with a warning. If you
// ever want true code splitting for these, move the lazy boundary up to
// the call site that owns the only path to the module.
import { ChatView } from "../components/pages/ChatView";
import { DatabasePageView } from "../components/pages/DatabasePageView";
import { LogsView } from "../components/pages/LogsView";
import { MemoryViewerView } from "../components/pages/MemoryViewerView";
import { PluginsPageView } from "../components/pages/PluginsPageView";
import { RelationshipsView } from "../components/pages/RelationshipsView";
import { RuntimeView } from "../components/pages/RuntimeView";
import { SkillsView } from "../components/pages/SkillsView";
import { TasksPageView } from "../components/pages/TasksPageView";
import { TrajectoriesView } from "../components/pages/TrajectoriesView";
import { FineTuningView } from "../components/training/injected";
import { useBootConfig } from "../config/boot-config-react";
import type { Tab } from "../navigation";
import { useApp } from "../state/useApp";
import { openExternalUrl } from "../utils";

interface AppWindowRendererProps {
  slug: string;
}

function AppWindowSuspense({
  children,
}: {
  children: JSX.Element;
}): JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
          Loading…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function RegisteredWalletInventoryView(): JSX.Element {
  const registration = listAppShellPages().find(
    (entry) => entry.id === "wallet.inventory" || entry.path === "/inventory",
  );
  if (!registration) {
    return <AppWindowError message="Wallet is not registered in this build." />;
  }
  const Component = registration.Component;
  return <Component />;
}

/** Render a built-in tab component bare (no chat pane / sidebar). */
function renderInternalToolTab(tab: Tab): JSX.Element | null {
  switch (tab) {
    case "plugins":
      return <PluginsPageView />;
    case "skills":
      return <SkillsView />;
    case "trajectories":
      return <TrajectoriesView />;
    case "relationships":
      return <RelationshipsView />;
    case "memories":
      return <MemoryViewerView />;
    case "runtime":
      return <RuntimeView />;
    case "database":
      return <DatabasePageView />;
    case "logs":
      return <LogsView />;
    case "fine-tuning":
    case "advanced":
      return <FineTuningView />;
    case "inventory":
      return <RegisteredWalletInventoryView />;
    case "tasks":
      return <TasksPageView />;
    case "chat":
      return <ChatView />;
    case "lifeops":
      // LifeOps is provided via the boot config injection so it can stay in
      // its own package. Handled separately by the lifeops branch below.
      return null;
    default:
      return null;
  }
}

function LifeOpsAppWindowView(): JSX.Element {
  const { lifeOpsPageView: LifeOpsPageView } = useBootConfig();
  if (!LifeOpsPageView) {
    return (
      <AppWindowError message="LifeOps is not registered in this build." />
    );
  }
  return (
    <AppWindowSuspense>
      <LifeOpsPageView />
    </AppWindowSuspense>
  );
}

function AppWindowError({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex h-screen min-h-0 w-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-txt">
      <div className="text-base font-semibold">Could not open app</div>
      <p className="max-w-md text-sm text-muted">{message}</p>
    </div>
  );
}

function AppWindowSpinner({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex h-screen min-h-0 w-screen flex-col items-center justify-center gap-2 bg-bg text-txt">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      <div className="text-sm text-muted">Launching {label}…</div>
    </div>
  );
}

function AppWindowFrame({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div className="flex h-screen min-h-0 w-screen flex-col overflow-hidden bg-bg text-txt">
      {children}
    </div>
  );
}

function exitAppWindow(): void {
  if (typeof window === "undefined") return;
  try {
    window.close();
  } catch {
    /* ignore — window.close may be no-op outside the app window context */
  }
}

function OverlayAppWindowView({ appName }: { appName: string }): JSX.Element {
  const overlay = getOverlayApp(appName);
  const { uiTheme, t } = useApp();

  if (!overlay) {
    return (
      <AppWindowError
        message={`Overlay app "${appName}" is not registered in this build.`}
      />
    );
  }

  const Component = overlay.Component;
  return (
    <Component
      exitToApps={exitAppWindow}
      uiTheme={uiTheme === "dark" ? "dark" : "light"}
      t={t}
    />
  );
}

interface RegistryRunState {
  status: "loading" | "ready" | "external" | "error";
  run: AppRunSummary | null;
  launchUrl: string | null;
  message: string | null;
}

function RegistryAppWindowView({ slug }: { slug: string }): JSX.Element {
  const { t } = useApp();
  const { catalog, error: catalogError } = useRegistryCatalog();
  const [runState, setRunState] = useState<RegistryRunState>({
    status: "loading",
    run: null,
    launchUrl: null,
    message: null,
  });
  const [retryCounter, setRetryCounter] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const authSentRef = useRef(false);

  const resolvedApp = useMemo<RegistryAppInfo | null>(() => {
    if (!catalog) return null;
    return findAppBySlug(catalog, slug) ?? null;
  }, [catalog, slug]);

  const displayName = resolvedApp?.displayName ?? slug;

  // Launch the app once we know the package name.
  useEffect(() => {
    if (!resolvedApp) return;
    let cancelled = false;
    setRunState({
      status: "loading",
      run: null,
      launchUrl: null,
      message:
        retryCounter > 0
          ? t("appwindow.RetryingLaunch", {
              defaultValue: "Retrying launch...",
            })
          : null,
    });
    authSentRef.current = false;

    void (async () => {
      try {
        const result: AppLaunchResult = await client.launchApp(
          resolvedApp.name,
        );
        if (cancelled) return;
        const run = result.run;
        if (run?.viewer?.url) {
          setRunState({
            status: "ready",
            run,
            launchUrl: null,
            message: null,
          });
          return;
        }
        const launchUrl = result.launchUrl ?? resolvedApp.launchUrl;
        if (launchUrl) {
          try {
            await openExternalUrl(launchUrl);
          } catch {
            /* ignore — we still surface the link state */
          }
          setRunState({
            status: "external",
            run: run ?? null,
            launchUrl,
            message: null,
          });
          return;
        }
        const diagnostic = result.diagnostics?.find(
          (d) => d.severity === "error",
        );
        setRunState({
          status: "error",
          run: run ?? null,
          launchUrl: null,
          message:
            diagnostic?.message ??
            t("appwindow.LaunchedNoViewer", {
              defaultValue:
                "This app launched without a viewer URL. Open it from the apps catalog.",
            }),
        });
      } catch (err) {
        if (cancelled) return;
        setRunState({
          status: "error",
          run: null,
          launchUrl: null,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [resolvedApp, retryCounter, t]);

  // postMessage auth handshake — mirrors GameViewOverlay / GameView.
  const run = runState.run;
  const viewerUrl = run?.viewer?.url ?? "";
  const resolvedViewerUrl = useMemo(
    () => (viewerUrl ? resolveEmbeddedViewerUrl(viewerUrl) : ""),
    [viewerUrl],
  );
  const targetOrigin = useMemo(
    () => (viewerUrl ? resolvePostMessageTargetOrigin(viewerUrl) : "*"),
    [viewerUrl],
  );
  const useEmbedded = useMemo(() => shouldUseEmbeddedAppViewer(run), [run]);
  const authMessage = run?.viewer?.authMessage ?? null;
  const requiresAuth = run?.viewer?.postMessageAuth === true;

  useEffect(() => {
    if (
      runState.status !== "ready" ||
      !useEmbedded ||
      !requiresAuth ||
      !authMessage
    ) {
      return;
    }
    if (authSentRef.current) return;
    const expectedReadyType = resolveViewerReadyEventType(authMessage);
    if (!expectedReadyType) return;

    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (authSentRef.current) return;
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;
      if (event.data?.type !== expectedReadyType) return;
      if (targetOrigin !== "*" && event.origin !== targetOrigin) return;
      iframeWindow.postMessage(authMessage, targetOrigin);
      authSentRef.current = true;
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [authMessage, requiresAuth, runState.status, targetOrigin, useEmbedded]);

  if (catalogError) {
    return <AppWindowError message={catalogError} />;
  }
  if (!catalog) {
    return <AppWindowSpinner label={slug} />;
  }
  if (!resolvedApp) {
    return (
      <AppWindowError
        message={`No installed or catalog app matches "/apps/${slug}".`}
      />
    );
  }

  if (runState.status === "loading") {
    return <AppWindowSpinner label={displayName} />;
  }

  if (runState.status === "error") {
    return (
      <div className="flex h-screen min-h-0 w-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-txt">
        <div className="text-base font-semibold">
          Could not launch {displayName}
        </div>
        {runState.message ? (
          <p className="max-w-md text-sm text-muted">{runState.message}</p>
        ) : null}
        <button
          type="button"
          className="rounded-full border border-border/60 bg-card/70 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-muted transition-colors hover:border-accent hover:text-foreground"
          onClick={() => setRetryCounter((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (runState.status === "external") {
    return (
      <div className="flex h-screen min-h-0 w-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-txt">
        <div className="text-base font-semibold">
          {displayName} opened in your browser
        </div>
        {runState.launchUrl ? (
          <p className="max-w-md text-sm text-muted break-all">
            {runState.launchUrl}
          </p>
        ) : null}
      </div>
    );
  }

  // status === "ready" && we have an embedded viewer URL.
  const sandbox = run?.viewer?.sandbox;
  return (
    <iframe
      ref={iframeRef}
      src={resolvedViewerUrl}
      {...(sandbox ? { sandbox } : {})}
      className="h-screen w-screen border-none"
      title={displayName}
      data-testid="app-window-viewer-iframe"
    />
  );
}

export function AppWindowRenderer({
  slug,
}: AppWindowRendererProps): JSX.Element {
  const internalTab = useMemo<Tab | null>(() => {
    // First, look up whether any internal tool app maps to this slug. Internal
    // tool apps register a windowPath like `/apps/plugins`; resolve via the
    // exposed helper so we don't duplicate the mapping.
    // We cannot reverse-look-up by slug directly, so iterate the descriptors.
    return resolveInternalToolTabFromSlug(slug);
  }, [slug]);

  if (internalTab === "lifeops") {
    return (
      <AppWindowFrame>
        <LifeOpsAppWindowView />
      </AppWindowFrame>
    );
  }

  if (internalTab) {
    const view = renderInternalToolTab(internalTab);
    if (view) {
      return (
        <AppWindowFrame>
          <AppWindowSuspense>{view}</AppWindowSuspense>
        </AppWindowFrame>
      );
    }
  }

  // Overlay apps register by package name. The slug is derived from the
  // package name via getAppSlug.
  const overlayName = resolveOverlayAppNameFromSlug(slug);
  if (overlayName) {
    return (
      <AppWindowFrame>
        <OverlayAppWindowView appName={overlayName} />
      </AppWindowFrame>
    );
  }

  // Otherwise, treat as a registry/catalog app slug and launch via the API.
  return (
    <AppWindowFrame>
      <RegistryAppWindowView slug={slug} />
    </AppWindowFrame>
  );
}

/**
 * Resolve a `/apps/<slug>` to its internal-tool target tab using the
 * internal-tool descriptor table as the source of truth.
 */
function resolveInternalToolTabFromSlug(slug: string): Tab | null {
  const targetPath = `/apps/${slug}`;
  for (const descriptor of getInternalToolAppDescriptors()) {
    if (descriptor.windowPath === targetPath) {
      const tab = getInternalToolAppTargetTab(descriptor.name);
      if (tab) return tab;
    }
  }
  return null;
}

/**
 * Reverse-lookup an overlay app name from its slug.
 *
 * Overlay apps register by package name (e.g. `@elizaos/app-companion`); the
 * slug is `getAppSlug(name)`. We iterate the registry to find a match.
 */
function resolveOverlayAppNameFromSlug(slug: string): string | null {
  for (const app of getAllOverlayApps()) {
    if (getAppSlug(app.name) === slug && isOverlayApp(app.name)) {
      return app.name;
    }
  }
  return null;
}
