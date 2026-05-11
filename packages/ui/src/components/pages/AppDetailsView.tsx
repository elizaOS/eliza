/**
 * AppDetailsView — config + diagnostics + widgets + Launch button page
 * for apps that need it (those with `hasDetailsPage: true` in their
 * descriptor, or any registry/catalog app with launch params).
 *
 * Mounted by AppsView when the apps sub-path is `/apps/<slug>/details`.
 */

import {
  Pin,
  PinOff,
  Rocket,
  Settings as SettingsIcon,
  TriangleAlert,
} from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { client, type RegistryAppInfo } from "../../api";
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../../bridge";
import { useApp } from "../../state/useApp";
import { openExternalUrl } from "../../utils";
import { getWidgetComponent } from "../../widgets/registry";
import type { PluginWidgetDeclaration } from "../../widgets/types";
import {
  isWidgetVisible,
  loadChatSidebarVisibility,
  saveChatSidebarVisibility,
  widgetVisibilityKey,
} from "../../widgets/visibility";
import { resolveRuntimeImageUrl } from "../apps/app-identity";
import { getAppDetailExtension } from "../apps/extensions/registry";
import { findAppBySlug, getAppSlug } from "../apps/helpers";
import {
  getInternalToolAppDescriptors,
  getInternalToolAppHasDetailsPage,
  getInternalToolApps,
  getInternalToolAppTargetTab,
  isInternalToolApp,
} from "../apps/internal-tool-apps";
import {
  getLaunchHistoryForApp,
  type LaunchAttemptRecord,
  recordLaunchAttempt,
} from "../apps/launch-history";
import {
  getAllOverlayApps,
  isOverlayApp,
  overlayAppToRegistryInfo,
} from "../apps/overlay-app-registry";
import {
  type AppLaunchMode,
  loadPerAppConfig,
  type PerAppConfig,
  savePerAppConfig,
  subscribePerAppConfig,
} from "../apps/per-app-config";
import { useRegistryCatalog } from "../apps/useRegistryCatalog";

interface AppDetailsViewProps {
  slug: string;
  /**
   * Called when the user successfully launches the app. The parent
   * (AppsView) navigates the apps sub-path back to "browse" or to the
   * inline run route depending on launch mode.
   */
  onLaunched?: (info: { mode: AppLaunchMode; slug: string }) => void;
}

type AppSource = "internal-tool" | "overlay" | "catalog" | "unknown";

interface ResolvedApp {
  source: AppSource;
  info: RegistryAppInfo;
  /** Plugin id derived from package name (e.g. `@elizaos/app-lifeops` → `lifeops`). */
  pluginId: string;
  windowPath: string;
}

function pluginIdFromName(name: string): string {
  return name.replace(/^@elizaos\/app-/, "");
}

function resolveAppFromSlug(
  slug: string,
  catalog: RegistryAppInfo[],
): ResolvedApp | null {
  // Internal tool by slug
  const internal = getInternalToolAppDescriptors().find(
    (d) => d.windowPath === `/apps/${slug}`,
  );
  if (internal) {
    const info = getInternalToolApps().find((a) => a.name === internal.name);
    if (info) {
      return {
        source: "internal-tool",
        info,
        pluginId: pluginIdFromName(internal.name),
        windowPath: internal.windowPath ?? `/apps/${slug}`,
      };
    }
  }

  // Overlay app by slug
  const overlay = getAllOverlayApps().find(
    (a) => getAppSlug(a.name) === slug && isOverlayApp(a.name),
  );
  if (overlay) {
    return {
      source: "overlay",
      info: overlayAppToRegistryInfo(overlay),
      pluginId: pluginIdFromName(overlay.name),
      windowPath: `/apps/${slug}`,
    };
  }

  // Catalog/registry app by slug
  const catalogHit = findAppBySlug(catalog, slug);
  if (catalogHit) {
    return {
      source: "catalog",
      info: catalogHit,
      pluginId: pluginIdFromName(catalogHit.name),
      windowPath: `/apps/${slug}`,
    };
  }

  return null;
}

function sourceLabel(source: AppSource): string {
  switch (source) {
    case "internal-tool":
      return "Internal Tool";
    case "overlay":
      return "Overlay App";
    case "catalog":
      return "Catalog App";
    default:
      return "Unknown";
  }
}

function appProvenanceBadges(app: RegistryAppInfo): Array<{
  key: string;
  label: string;
  className: string;
  title?: string;
}> {
  const isThirdParty = app.thirdParty === true || app.origin === "third-party";
  const isBuiltIn = app.builtIn === true || app.origin === "builtin";
  const isFirstParty = app.firstParty === true || app.support === "first-party";
  const isCommunity =
    app.support === "community" || (isThirdParty && !isFirstParty);
  const title = isThirdParty
    ? "Community app registered through the plugin registry"
    : isBuiltIn || isFirstParty
      ? "First-party app generated from the elizaOS plugin registry"
      : undefined;
  const badges: Array<{
    key: string;
    label: string;
    className: string;
    title?: string;
  }> = [];

  if (isThirdParty) {
    badges.push({
      key: "origin",
      label: "Third party",
      className: "border-border/60 text-muted",
      title,
    });
  } else if (isBuiltIn) {
    badges.push({
      key: "origin",
      label: "Built in",
      className: "border-border/60 text-muted",
      title,
    });
  }

  if (isCommunity) {
    badges.push({
      key: "support",
      label: "Community",
      className: "border-warn/45 text-warn",
      title,
    });
  } else if (isFirstParty) {
    badges.push({
      key: "support",
      label: "First party",
      className: "border-accent/45 text-accent",
      title,
    });
  }

  return badges;
}

function isOverlayLaunchApp(app: RegistryAppInfo): boolean {
  return isOverlayApp(app.name) || app.launchType === "overlay";
}

function formatTimestamp(value: number): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatLabel(value: string): string {
  return value.replaceAll("-", " ");
}

function SectionHeader({ children }: { children: string }): JSX.Element {
  return (
    <h3 className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-accent">
      {children}
    </h3>
  );
}

function ChipList({ items }: { items: readonly string[] }): JSX.Element {
  if (items.length === 0) {
    return <span className="text-xs text-muted">None declared</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="rounded-full border border-border/60 bg-card/50 px-2 py-0.5 text-xs text-muted"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function WidgetPreview({
  declaration,
  pluginId,
}: {
  declaration: PluginWidgetDeclaration;
  pluginId: string;
}): JSX.Element {
  const Component = useMemo(
    () => getWidgetComponent(pluginId, declaration.id),
    [declaration.id, pluginId],
  );
  if (!Component) {
    return (
      <div className="rounded-md border border-border/40 bg-card/30 px-3 py-2 text-xs text-muted">
        No bundled component for this widget — preview unavailable.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border/40 bg-card/30 p-3">
      <Component pluginId={pluginId} events={[]} clearEvents={() => {}} />
    </div>
  );
}

export function AppDetailsView({
  slug,
  onLaunched,
}: AppDetailsViewProps): JSX.Element {
  const { plugins, appRuns, t, setTab, setState, setActionNotice } = useApp();

  // Catalog of registry apps for slug → app resolution.
  const { catalog: registryCatalog, error: catalogError } =
    useRegistryCatalog();
  const catalog: RegistryAppInfo[] = registryCatalog ?? [];

  const resolved = useMemo(
    () => resolveAppFromSlug(slug, catalog),
    [catalog, slug],
  );

  // Per-app config (launch mode, alwaysOnTop, free-form settings).
  const [config, setConfig] = useState<PerAppConfig>(() =>
    loadPerAppConfig(slug),
  );
  useEffect(() => {
    setConfig(loadPerAppConfig(slug));
    return subscribePerAppConfig(slug, setConfig);
  }, [slug]);

  const updateConfig = useCallback(
    (next: Partial<PerAppConfig>) => {
      const merged: PerAppConfig = {
        launchMode: next.launchMode ?? config.launchMode,
        alwaysOnTop:
          next.alwaysOnTop !== undefined
            ? next.alwaysOnTop
            : config.alwaysOnTop,
        settings: next.settings ?? config.settings,
      };
      setConfig(merged);
      savePerAppConfig(slug, merged);
    },
    [config, slug],
  );

  // Widget visibility — re-uses the existing chat-sidebar visibility store.
  const [visibility, setVisibility] = useState(() =>
    loadChatSidebarVisibility(),
  );
  const toggleWidget = useCallback(
    (decl: PluginWidgetDeclaration, enabled: boolean) => {
      const key = widgetVisibilityKey(decl.pluginId, decl.id);
      const nextOverrides = { ...visibility.overrides, [key]: enabled };
      const next = { overrides: nextOverrides };
      setVisibility(next);
      saveChatSidebarVisibility(next);
    },
    [visibility],
  );

  // Widgets owned by this app's plugin. Server-declared widgets carry
  // `slot: string`; narrow to the WidgetSlot literal union here so the
  // rest of the component can rely on it.
  const widgets = useMemo<PluginWidgetDeclaration[]>(() => {
    if (!resolved) return [];
    const ownPlugin = plugins?.find((p) => p.id === resolved.pluginId);
    const raw = ownPlugin?.widgets ?? [];
    return raw.map(
      (decl): PluginWidgetDeclaration => ({
        ...decl,
        slot: decl.slot as PluginWidgetDeclaration["slot"],
      }),
    );
  }, [plugins, resolved]);
  const [expandedWidget, setExpandedWidget] = useState<string | null>(null);

  // Launch history for diagnostics.
  const [history, setHistory] = useState<LaunchAttemptRecord[]>([]);
  useEffect(() => {
    if (resolved) setHistory(getLaunchHistoryForApp(resolved.info.name));
  }, [resolved]);

  // Recent runs (live).
  const recentRuns = useMemo(() => {
    if (!resolved || !appRuns) return [];
    return appRuns.filter((r) => r.appName === resolved.info.name).slice(0, 5);
  }, [appRuns, resolved]);

  // Launch action.
  const [launching, setLaunching] = useState(false);
  const handleLaunch = useCallback(async () => {
    if (!resolved || launching) return;
    setLaunching(true);
    const recordResult = (succeeded: boolean, errorMessage?: string) => {
      recordLaunchAttempt({
        appName: resolved.info.name,
        timestamp: Date.now(),
        succeeded,
        diagnostics: [],
        ...(errorMessage ? { errorMessage } : {}),
      });
      setHistory(getLaunchHistoryForApp(resolved.info.name));
    };
    try {
      if (config.launchMode === "inline") {
        // Inline: for internal tools, switch the main shell tab; for
        // overlays, set activeOverlayApp; otherwise fall back to window.
        if (resolved.source === "internal-tool") {
          const tab = getInternalToolAppTargetTab(resolved.info.name);
          if (tab) {
            setTab(tab);
            recordResult(true);
            onLaunched?.({ mode: "inline", slug });
            return;
          }
        }
        if (
          resolved.source === "overlay" ||
          isOverlayLaunchApp(resolved.info)
        ) {
          setState("activeOverlayApp", resolved.info.name);
          recordResult(true);
          onLaunched?.({ mode: "inline", slug });
          return;
        }
        // Fall through to window mode — inline not supported for this app.
      }

      if (!isElectrobunRuntime()) {
        const tab = getInternalToolAppTargetTab(resolved.info.name);
        if (tab) {
          setTab(tab);
          recordResult(true);
          onLaunched?.({ mode: "inline", slug });
          return;
        }
        if (isOverlayLaunchApp(resolved.info)) {
          setState("activeOverlayApp", resolved.info.name);
          recordResult(true);
          onLaunched?.({ mode: "inline", slug });
          return;
        }

        const result = await client.launchApp(resolved.info.name);
        const primaryDiagnostic =
          result.diagnostics?.find(
            (diagnostic) => diagnostic.severity === "error",
          ) ?? result.diagnostics?.[0];
        const launchedRun = result.run;
        if (launchedRun?.viewer?.url) {
          setState("appRuns", [
            launchedRun,
            ...appRuns.filter((run) => run.runId !== launchedRun.runId),
          ]);
          setState("activeGameRunId", launchedRun.runId);
          setState("tab", "apps");
          setState("appsSubTab", "games");
          recordResult(true);
          onLaunched?.({ mode: "window", slug });
          return;
        }

        const targetUrl = result.launchUrl ?? resolved.info.launchUrl;
        if (targetUrl) {
          await openExternalUrl(targetUrl);
          recordResult(true);
          onLaunched?.({ mode: "window", slug });
          return;
        }

        throw new Error(
          primaryDiagnostic?.message ??
            t("appdetails.LaunchedNoViewer", {
              defaultValue: "This app launched without a viewer URL.",
            }),
        );
      }

      // Window mode (default).
      const created = await invokeDesktopBridgeRequest<{
        id: string;
        alwaysOnTop: boolean;
      } | null>({
        rpcMethod: "desktopOpenAppWindow",
        ipcChannel: "desktop:openAppWindow",
        params: {
          slug,
          title: resolved.info.displayName ?? resolved.info.name,
          path: resolved.windowPath,
          alwaysOnTop: config.alwaysOnTop,
        },
      });
      if (!created?.id) {
        throw new Error("Desktop bridge declined to open the window.");
      }
      recordResult(true);
      onLaunched?.({ mode: "window", slug });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordResult(false, message);
      setActionNotice(
        t("appdetails.LaunchFailed", {
          defaultValue: `Could not launch ${resolved.info.displayName}: ${message}`,
        }),
        "error",
        4000,
      );
    } finally {
      setLaunching(false);
    }
  }, [
    appRuns,
    config.alwaysOnTop,
    config.launchMode,
    launching,
    onLaunched,
    resolved,
    setActionNotice,
    setState,
    setTab,
    slug,
    t,
  ]);

  if (catalogError && !resolved) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
        <TriangleAlert className="h-5 w-5 text-accent" />
        <span>{catalogError}</span>
      </div>
    );
  }
  if (!resolved) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center text-sm text-muted">
        Loading {slug}…
      </div>
    );
  }

  const isInternal = resolved.source === "internal-tool";
  const supportsInlineMode = isInternal || resolved.source === "overlay";
  const DetailExtension = getAppDetailExtension(resolved.info);
  const activeRun = recentRuns[0] ?? null;
  const latestFailure = history.find((entry) => !entry.succeeded);
  const viewerUrl = resolved.info.viewer?.url ?? resolved.info.launchUrl;
  const launchTarget = viewerUrl ?? resolved.windowPath;
  const sessionMode = resolved.info.session?.mode;
  const sessionFeatures = resolved.info.session?.features ?? [];
  const provenanceBadges = appProvenanceBadges(resolved.info);
  const launchModeLabel =
    config.launchMode === "inline" && supportsInlineMode
      ? "Main window"
      : "Dedicated window";

  return (
    <div className="device-layout mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 lg:px-6">
      {/* Header */}
      <header className="flex flex-col gap-3 border-b border-border/35 pb-5">
        <div className="flex items-center gap-4">
          {resolved.info.heroImage ? (
            <img
              src={resolveRuntimeImageUrl(resolved.info.heroImage)}
              alt=""
              className="h-14 w-14 rounded-lg border border-border/40 object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-border/40 bg-card/40 text-xs uppercase text-muted">
              {(resolved.info.displayName ?? resolved.info.name)
                .slice(0, 2)
                .toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">
              {resolved.info.displayName ?? resolved.info.name}
            </h2>
            <p className="truncate text-xs text-muted">{resolved.info.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-muted">
              <span>{sourceLabel(resolved.source)}</span>
              {provenanceBadges.map((badge) => (
                <span
                  key={badge.key}
                  title={badge.title}
                  className={`rounded-full border px-2 py-0.5 ${badge.className}`}
                >
                  {badge.label}
                </span>
              ))}
              {recentRuns.length > 0 ? (
                <span className="rounded-full bg-accent/15 px-2 py-0.5 text-accent">
                  {recentRuns.length} running
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <section
        data-testid="app-launch-panel"
        className="flex flex-col gap-4 rounded-lg border border-border/45 bg-card/30 p-4"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <SectionHeader>Launch</SectionHeader>
            <p className="text-xs text-muted">
              {activeRun
                ? `${activeRun.displayName} is ${activeRun.status}.`
                : "Ready to launch."}
            </p>
          </div>
          <button
            type="button"
            onClick={handleLaunch}
            disabled={launching}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
            {launching
              ? "Launching..."
              : `Launch ${resolved.info.displayName ?? "App"}`}
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0 border-l border-border/35 pl-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              Run
            </div>
            <div className="truncate text-sm font-medium text-foreground">
              {activeRun?.status ?? "Ready"}
            </div>
          </div>
          <div className="min-w-0 border-l border-border/35 pl-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              Window
            </div>
            <div className="truncate text-sm font-medium text-foreground">
              {launchModeLabel}
            </div>
          </div>
          <div className="min-w-0 border-l border-border/35 pl-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              Target
            </div>
            <div
              className="truncate text-sm font-medium text-foreground"
              title={launchTarget}
            >
              {viewerUrl ? "Viewer" : "App route"}
            </div>
          </div>
          <div className="min-w-0 border-l border-border/35 pl-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              Session
            </div>
            <div className="truncate text-sm font-medium text-foreground">
              {sessionMode ? formatLabel(sessionMode) : "Not declared"}
            </div>
          </div>
        </div>

        {sessionFeatures.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {sessionFeatures.map((feature) => (
              <span
                key={feature}
                className="rounded-full border border-border/60 bg-card/50 px-2 py-0.5 text-xs text-muted"
              >
                {formatLabel(feature)}
              </span>
            ))}
          </div>
        ) : null}

        {latestFailure ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-muted">
            <span className="font-medium text-destructive">Last failure: </span>
            {latestFailure.errorMessage ?? "Launch failed."}
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-2 rounded-md border border-border/40 bg-bg/20 p-3">
          <legend className="px-1 text-xs uppercase tracking-[0.14em] text-muted">
            <SettingsIcon className="mr-1 inline h-3 w-3" /> Launch Destination
          </legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              checked={config.launchMode === "window"}
              onChange={() => updateConfig({ launchMode: "window" })}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span>Dedicated window</span>
          </label>
          <label
            className={`flex items-center gap-2 text-sm ${
              supportsInlineMode
                ? "cursor-pointer"
                : "cursor-not-allowed opacity-50"
            }`}
          >
            <input
              type="radio"
              checked={config.launchMode === "inline"}
              disabled={!supportsInlineMode}
              onChange={() => updateConfig({ launchMode: "inline" })}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span>
              Main window{!supportsInlineMode ? " (not supported)" : ""}
            </span>
          </label>
        </fieldset>

        <label
          className={`inline-flex items-center gap-2 self-start rounded-full border border-border/60 bg-bg/20 px-3 py-1.5 text-xs ${
            config.launchMode === "window"
              ? "cursor-pointer"
              : "cursor-not-allowed opacity-50"
          }`}
        >
          <input
            type="checkbox"
            checked={config.alwaysOnTop}
            disabled={config.launchMode !== "window"}
            onChange={(event) =>
              updateConfig({ alwaysOnTop: event.currentTarget.checked })
            }
            className="h-3.5 w-3.5 accent-accent"
          />
          {config.alwaysOnTop ? (
            <Pin className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>Keep this app's window on top</span>
        </label>
      </section>

      {/* Description + Capabilities */}
      <section className="flex flex-col gap-3">
        <SectionHeader>About</SectionHeader>
        {resolved.info.description ? (
          <p className="text-sm text-muted">{resolved.info.description}</p>
        ) : null}
        <ChipList items={resolved.info.capabilities ?? []} />
      </section>

      {DetailExtension ? (
        <section className="flex flex-col gap-3">
          <SectionHeader>Details</SectionHeader>
          <DetailExtension app={resolved.info} />
        </section>
      ) : null}

      {/* Recent runs */}
      {recentRuns.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeader>Recent Runs</SectionHeader>
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {recentRuns.map((run) => (
              <li
                key={run.runId}
                className="flex items-center justify-between rounded-md border border-border/40 bg-card/30 px-3 py-1.5"
              >
                <span className="truncate">{run.runId}</span>
                <span className="ml-2 shrink-0 uppercase tracking-[0.14em]">
                  {run.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Diagnostics */}
      <section className="flex flex-col gap-2">
        <SectionHeader>Launch Diagnostics</SectionHeader>
        {history.length === 0 ? (
          <p className="text-xs text-muted">No launch history yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {history.slice(0, 5).map((entry) => (
              <li
                key={entry.timestamp}
                className="rounded-md border border-border/40 bg-card/30 px-3 py-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-muted">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                  <span
                    className={
                      entry.succeeded ? "text-accent" : "text-destructive"
                    }
                  >
                    {entry.succeeded ? "OK" : "FAILED"}
                  </span>
                </div>
                {entry.errorMessage ? (
                  <p className="mt-1 text-muted">{entry.errorMessage}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Widgets */}
      {widgets.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeader>Widgets</SectionHeader>
          <ul className="flex flex-col gap-2">
            {widgets.map((decl) => {
              const visible = isWidgetVisible(decl, visibility.overrides);
              const widgetKey = widgetVisibilityKey(decl.pluginId, decl.id);
              const expanded = expandedWidget === widgetKey;
              return (
                <li
                  key={widgetKey}
                  className="rounded-md border border-border/40 bg-card/30"
                >
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {decl.label}
                      </div>
                      <div className="truncate text-[10px] uppercase tracking-[0.14em] text-muted">
                        {decl.slot}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedWidget(expanded ? null : widgetKey)
                        }
                        className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-foreground"
                      >
                        {expanded ? "Hide" : "Preview"}
                      </button>
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={visible}
                          onChange={(event) =>
                            toggleWidget(decl, event.currentTarget.checked)
                          }
                          className="h-3.5 w-3.5 accent-accent"
                        />
                        <span className="text-muted">Show</span>
                      </label>
                    </div>
                  </div>
                  {expanded ? (
                    <div className="border-t border-border/40 p-3">
                      <WidgetPreview
                        declaration={decl}
                        pluginId={resolved.pluginId}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Convenience: does this slug resolve to an app that wants the details
 * page? Used by AppsView.handleLaunch to decide whether to navigate to
 * /apps/<slug>/details or call openAppRouteWindow directly.
 *
 * Internal tools opt in with `hasDetailsPage`; catalog apps opt in through
 * launch metadata that implies setup, runtime control, or a heavier session.
 */
export function appNeedsDetailsPage(app: RegistryAppInfo | string): boolean {
  const name = typeof app === "string" ? app : app.name;
  if (isInternalToolApp(name)) {
    return getInternalToolAppHasDetailsPage(name);
  }
  if (isOverlayApp(name)) {
    return false;
  }
  if (typeof app !== "string" && app.launchType === "overlay") {
    return false;
  }
  if (typeof app === "string") {
    return false;
  }
  if (app.uiExtension?.detailPanelId) {
    return true;
  }
  if (app.session) {
    return true;
  }
  if (app.category.trim().toLowerCase() === "game") {
    return true;
  }
  return false;
}
