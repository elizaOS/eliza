/** Desktop app windows share the declared internal-tool, page and catalog routes. */

import type {
  AppLaunchResult,
  AppRunSummary,
  RegistryAppInfo,
} from "@elizaos/core/protocol";
import { formatError } from "@elizaos/core/protocol";
import {
  type ComponentType,
  type JSX,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import {
  appShellAgentSurfaceDescriptor,
  listAppShellPages,
  requireRegisteredAgentSurface,
} from "../../app-shell-registry";
import type { Tab } from "../../navigation";
import { useApp } from "../../state/useApp";
import { openExternalUrl } from "../../utils/openExternalUrl";
import { DatabasePageView } from "../pages/DatabasePageView";
import { FilesView } from "../pages/FilesView";
import { LogsView } from "../pages/LogsView";
import { MemoryViewerView } from "../pages/MemoryViewerView";
import { PluginsPageView } from "../pages/PluginsPageView";
import { RuntimeView } from "../pages/RuntimeView";
import { SkillsView } from "../pages/SkillsView";
import { TasksPageView } from "../pages/TasksPageView";
import { TrajectoriesView } from "../pages/TrajectoriesView";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Spinner } from "../ui/spinner";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { resolveDeclaredAppWindowRoute } from "./AppWindowRenderer.route-resolution";
import { EmbeddedAppViewer } from "./EmbeddedAppViewer";
import { findAppBySlug } from "./helpers";
import { useRegistryCatalog } from "./useRegistryCatalog";
import { sanitizeGameViewerSandbox } from "./viewer-auth";

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
const appShellPageLazyComponentCache = new WeakMap<
  NonNullable<ReturnType<typeof listAppShellPages>[number]["loader"]>,
  ComponentType<Record<string, unknown>>
>();
function getAppShellPageLazyComponent(
  loader: NonNullable<ReturnType<typeof listAppShellPages>[number]["loader"]>,
): ComponentType<Record<string, unknown>> {
  const existing = appShellPageLazyComponentCache.get(loader);
  if (existing) return existing;
  const created = lazy(loader);
  appShellPageLazyComponentCache.set(loader, created);
  return created;
}
function RegisteredAppShellPageView({
  registration,
}: {
  registration: ReturnType<typeof listAppShellPages>[number];
}): JSX.Element {
  const Component =
    registration.Component ??
    (registration.loader
      ? getAppShellPageLazyComponent(registration.loader)
      : null);
  if (!Component) {
    return (
      <AppWindowError
        message={`${registration.label || registration.id} is not available in this window.`}
      />
    );
  }
  const descriptor = requireRegisteredAgentSurface(
    appShellAgentSurfaceDescriptor(registration),
  );
  return (
    <ShellViewAgentSurface
      viewId={descriptor.viewId}
      surfaceKind={descriptor.kind}
      capabilities={registration.capabilities}
      surface={registration.surface}
      interact={registration.interact}
    >
      <Component />
    </ShellViewAgentSurface>
  );
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
    case "relationships": {
      const registration = listAppShellPages().find(
        (entry) => entry.id === "relationships",
      );
      return registration ? (
        <RegisteredAppShellPageView registration={registration} />
      ) : (
        <AppWindowError message="Relationships is not registered in this build." />
      );
    }
    case "memories":
      return <MemoryViewerView />;
    case "runtime":
      return <RuntimeView />;
    case "database":
      return <DatabasePageView />;
    case "files":
      return <FilesView />;
    case "logs":
      return <LogsView />;
    case "tasks":
      return <TasksPageView />;
    default:
      return null;
  }
}
function AppWindowError({ message }: { message: string }): JSX.Element {
  return (
    <Card
      variant="appWindowState"
      className="flex h-dvh min-h-0 w-full flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <div className="text-base font-semibold">Could not open app</div>
      <p className="max-w-md text-sm text-muted">{message}</p>
    </Card>
  );
}
function AppWindowSpinner({ label }: { label: string }): JSX.Element {
  const { t } = useApp();
  return (
    <div className="flex h-dvh min-h-0 w-full flex-col items-center justify-center gap-2 bg-bg text-txt">
      <Spinner className="size-6" />
      <div className="text-sm text-muted">
        {t("appwindow.Launching", {
          defaultValue: "Launching {{label}}…",
          label,
        })}
      </div>
    </div>
  );
}
function AppWindowFrame({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-bg text-txt">
      {children}
    </div>
  );
}
interface RegistryRunState {
  status: "loading" | "ready" | "external" | "error";
  run: AppRunSummary | null;
  launchUrl: string | null;
  message: string | null;
}
export function RegistryAppWindowView({ slug }: { slug: string }): JSX.Element {
  const { t } = useApp();
  const { catalog, error: catalogError } = useRegistryCatalog();
  const [runState, setRunState] = useState<RegistryRunState>({
    status: "loading",
    run: null,
    launchUrl: null,
    message: null,
  });
  const [retryCounter, setRetryCounter] = useState(0);
  const launchRef = useRef<{
    name: string;
    retry: number;
    promise: Promise<AppLaunchResult>;
  } | null>(null);

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
    // Keep one launch per selected app/retry across effect replay and locale
    // changes. Each subscriber still drops stale results on cleanup.
    if (
      launchRef.current?.name !== resolvedApp.name ||
      launchRef.current.retry !== retryCounter
    ) {
      launchRef.current = {
        name: resolvedApp.name,
        retry: retryCounter,
        promise: client.launchApp(resolvedApp.name),
      };
    }
    const launch = launchRef.current.promise;
    void (async () => {
      try {
        const result = await launch;
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
          // openExternalUrl resolves false when nothing was opened (URL fails
          // the navigation allowlist, or the desktop bridge refused); only a
          // real navigation may report "opened in your browser".
          const opened = await openExternalUrl(launchUrl).catch(() => false);
          if (cancelled) return;
          if (!opened) {
            setRunState({
              status: "error",
              run: run ?? null,
              launchUrl: null,
              message: t("appwindow.ExternalOpenFailed", {
                url: launchUrl,
                defaultValue:
                  "Could not open this app in your browser: {{url}}",
              }),
            });
            return;
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
          message: formatError(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolvedApp, retryCounter, t]);
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
      <Card
        variant="appWindowState"
        className="flex h-dvh min-h-0 w-full flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <div className="text-base font-semibold">
          Could not launch {displayName}
        </div>
        {runState.message ? (
          <p className="max-w-md text-sm text-muted">{runState.message}</p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          shape="circle"
          className="text-xs font-semibold uppercase tracking-[0.16em]"
          onClick={() => setRetryCounter((n) => n + 1)}
        >
          Retry
        </Button>
      </Card>
    );
  }
  if (runState.status === "external") {
    return (
      <div className="flex h-dvh min-h-0 w-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-txt">
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
  const run = runState.run;
  const viewerUrl = run?.viewer?.url ?? "";
  return (
    <EmbeddedAppViewer
      key={`${run?.runId ?? ""}:${viewerUrl}`}
      viewerUrl={viewerUrl}
      authMessage={
        run?.viewer?.postMessageAuth === true ? run.viewer.authMessage : null
      }
      sandbox={sanitizeGameViewerSandbox(run?.viewer?.sandbox, viewerUrl)}
      title={displayName}
      className="h-dvh w-full border-none"
    />
  );
}

export function DeclaredAppWindowSurface({
  slug,
}: {
  slug: string;
}): JSX.Element {
  const route = resolveDeclaredAppWindowRoute(slug);
  const content =
    route?.kind === "internal" ? (
      renderInternalToolTab(route.tab)
    ) : route?.kind === "page" ? (
      <RegisteredAppShellPageView registration={route.page} />
    ) : null;
  return (
    <AppWindowFrame>
      <AppWindowSuspense>
        {content ?? (
          <AppWindowError
            message={`No registered page matches /apps/${slug}.`}
          />
        )}
      </AppWindowSuspense>
    </AppWindowFrame>
  );
}
