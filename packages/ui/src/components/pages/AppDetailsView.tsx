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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client, type RegistryAppInfo } from "../../api";
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../../bridge";
import { useAppSelectorShallow } from "../../state";
import type { TranslationContextValue } from "../../state/TranslationContext.hooks";
import { openExternalUrl } from "../../utils";
import { getWidgetComponent } from "../../widgets/registry";
import type { PluginWidgetDeclaration } from "../../widgets/types";
import {
  isWidgetVisible,
  loadChatSidebarVisibility,
  saveChatSidebarVisibility,
  widgetVisibilityKey,
} from "../../widgets/visibility";
import { resolveRuntimeImageUrl } from "../apps/app-identity.helpers";
import { getAppDetailExtension } from "../apps/extensions/registry";
import { findAppBySlug, getAppSlug } from "../apps/helpers";
import {
  getInternalToolAppDescriptors,
  getInternalToolApps,
  getInternalToolAppTargetTab,
} from "../apps/internal-tool-apps";
import {
  getLaunchHistoryForApp,
  type LaunchAttemptRecord,
  recordLaunchAttempt,
} from "../apps/launch-history";
import {
  getAvailableOverlayApps,
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
import { getProvenanceFlags, getProvenanceTitle } from "../apps/provenance";
import { useRegistryCatalog } from "../apps/useRegistryCatalog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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
  /** Plugin id derived from package name (e.g. `@elizaos/plugin-personal-assistant` → `lifeops`). */
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
  const overlay = getAvailableOverlayApps().find(
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

type TranslateFn = TranslationContextValue["t"];

function sourceLabel(source: AppSource, t: TranslateFn): string {
  switch (source) {
    case "internal-tool":
      return t("appdetails.source.internalTool", {
        defaultValue: "Internal Tool",
      });
    case "overlay":
      return t("appdetails.source.overlay", { defaultValue: "Overlay App" });
    case "catalog":
      return t("appdetails.source.catalog", { defaultValue: "Catalog App" });
    default:
      return t("appdetails.source.unknown", { defaultValue: "Unknown" });
  }
}

function appProvenanceBadges(
  app: RegistryAppInfo,
  t: TranslateFn,
): Array<{
  key: string;
  label: string;
  className: string;
  title?: string;
}> {
  const flags = getProvenanceFlags(app);
  const title = getProvenanceTitle(flags, "app");
  const badges: Array<{
    key: string;
    label: string;
    className: string;
    title?: string;
  }> = [];

  if (flags.isThirdParty) {
    badges.push({
      key: "origin",
      label: t("appdetails.badge.thirdParty", { defaultValue: "Third party" }),
      className: "text-muted",
      title,
    });
  } else if (flags.isBuiltIn) {
    badges.push({
      key: "origin",
      label: t("appdetails.badge.builtIn", { defaultValue: "Built in" }),
      className: "text-muted",
      title,
    });
  }

  if (flags.isCommunity) {
    badges.push({
      key: "support",
      label: t("appdetails.badge.community", { defaultValue: "Community" }),
      className: "text-warn",
      title,
    });
  } else if (flags.isFirstParty) {
    badges.push({
      key: "support",
      label: t("appdetails.badge.firstParty", { defaultValue: "First party" }),
      className: "text-accent",
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

function SectionHeader({ children }: { children: string }): React.JSX.Element {
  return (
    <h3 className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-accent">
      {children}
    </h3>
  );
}

function ChipList({
  items,
  t,
}: {
  items: readonly string[];
  t: TranslateFn;
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <span className="text-xs text-muted">
        {t("appdetails.noneDeclared", { defaultValue: "None declared" })}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {items.map((item) => (
        <span key={item} className="text-xs text-muted">
          {item}
        </span>
      ))}
    </div>
  );
}

function WidgetPreview({
  declaration,
  pluginId,
  t,
}: {
  declaration: PluginWidgetDeclaration;
  pluginId: string;
  t: TranslateFn;
}): React.JSX.Element {
  const Component = useMemo(
    () => getWidgetComponent(pluginId, declaration.id),
    [declaration.id, pluginId],
  );
  if (!Component) {
    return (
      <div className="text-xs text-muted">
        {t("appdetails.widgetPreviewUnavailable", {
          defaultValue:
            "No bundled component for this widget — preview unavailable.",
        })}
      </div>
    );
  }
  /* Flat — widgets render chromeless, directly on the page. */
  return <Component pluginId={pluginId} events={[]} clearEvents={() => {}} />;
}

function WidgetRow({
  declaration,
  pluginId,
  visible,
  expanded,
  onTogglePreview,
  onToggleVisible,
  t,
}: {
  declaration: PluginWidgetDeclaration;
  pluginId: string;
  visible: boolean;
  expanded: boolean;
  onTogglePreview: () => void;
  onToggleVisible: (enabled: boolean) => void;
  t: TranslateFn;
}): React.JSX.Element {
  const widgetKey = widgetVisibilityKey(declaration.pluginId, declaration.id);
  const previewButton = useAgentElement<HTMLButtonElement>({
    id: `widget-preview-${widgetKey}`,
    role: "button",
    label:
      t("appdetails.preview", { defaultValue: "Preview" }) +
      ` — ${declaration.label}`,
    group: "app-widgets",
    status: expanded ? "active" : "inactive",
    description: `Toggle preview of the ${declaration.label} widget`,
    onActivate: onTogglePreview,
  });
  const showToggle = useAgentElement<HTMLInputElement>({
    id: `widget-show-${widgetKey}`,
    role: "toggle",
    label:
      t("appdetails.show", { defaultValue: "Show" }) +
      ` — ${declaration.label}`,
    group: "app-widgets",
    status: visible ? "active" : "inactive",
    description: `Show or hide the ${declaration.label} widget`,
    getValue: () => visible,
    onActivate: () => onToggleVisible(!visible),
  });
  return (
    /* Flat — no card/border. Rows separate by whitespace. */
    <li>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {declaration.label}
          </div>
          <div className="truncate text-[10px] uppercase tracking-[0.14em] text-muted">
            {declaration.slot}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            ref={previewButton.ref}
            onClick={onTogglePreview}
            /* Flat — borderless pill; hover fill is the affordance. */
            variant="ghost"
            size="sm"
            className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:bg-surface hover:text-foreground"
            {...previewButton.agentProps}
          >
            {expanded
              ? t("appdetails.hide", { defaultValue: "Hide" })
              : t("appdetails.preview", {
                  defaultValue: "Preview",
                })}
          </Button>
          <label
            htmlFor={`app-widget-visible-${widgetKey}`}
            className="inline-flex cursor-pointer items-center gap-1.5 text-xs"
          >
            <Input
              id={`app-widget-visible-${widgetKey}`}
              ref={showToggle.ref}
              type="checkbox"
              checked={visible}
              onChange={(event) => onToggleVisible(event.currentTarget.checked)}
              className="h-3.5 w-3.5 border-border p-0 accent-accent"
              {...showToggle.agentProps}
            />
            <span className="text-muted">
              {t("appdetails.show", { defaultValue: "Show" })}
            </span>
          </label>
        </div>
      </div>
      {expanded ? (
        <div className="px-3 pb-3">
          <WidgetPreview declaration={declaration} pluginId={pluginId} t={t} />
        </div>
      ) : null}
    </li>
  );
}

export function AppDetailsView({
  slug,
  onLaunched,
}: AppDetailsViewProps): React.JSX.Element {
  const { plugins, appRuns, t, setTab, setState, setActionNotice } =
    useAppSelectorShallow((s) => ({
      plugins: s.plugins,
      appRuns: s.appRuns,
      t: s.t,
      setTab: s.setTab,
      setState: s.setState,
      setActionNotice: s.setActionNotice,
    }));

  // Catalog of registry apps for slug → app resolution.
  const {
    catalog: registryCatalog,
    error: catalogError,
    loading: catalogLoading,
  } = useRegistryCatalog();
  // Stabilize identity: `registryCatalog ?? []` would mint a fresh array every
  // render while the registry is still loading (registryCatalog nullish), which
  // re-recomputes `resolved` and re-fires the launch-history effect every
  // render — an infinite render loop on first paint. Memoize so it only changes
  // when the underlying catalog actually changes.
  const catalog = useMemo<RegistryAppInfo[]>(
    () => registryCatalog ?? [],
    [registryCatalog],
  );

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
        throw new Error(
          t("appdetails.bridgeDeclined", {
            defaultValue: "Desktop bridge declined to open the window.",
          }),
        );
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

  const supportsInline =
    resolved?.source === "internal-tool" || resolved?.source === "overlay";

  const launchButton = useAgentElement<HTMLButtonElement>({
    id: "launch",
    role: "button",
    label: t("appdetails.launch", { defaultValue: "Launch" }),
    group: "app-launch",
    status: launching ? "active" : "inactive",
    description: "Launch this app",
    onActivate: () => void handleLaunch(),
  });
  const launchModeWindowRadio = useAgentElement<HTMLInputElement>({
    id: "launch-mode-window",
    role: "toggle",
    label: t("appdetails.dedicatedWindow", {
      defaultValue: "Dedicated window",
    }),
    group: "launch-mode",
    status: config.launchMode === "window" ? "active" : "inactive",
    description: "Launch this app in a dedicated window",
    getValue: () => config.launchMode === "window",
    onActivate: () => updateConfig({ launchMode: "window" }),
  });
  const launchModeInlineRadio = useAgentElement<HTMLInputElement>({
    id: "launch-mode-inline",
    role: "toggle",
    label: t("appdetails.mainWindow", { defaultValue: "Main window" }),
    group: "launch-mode",
    status: config.launchMode === "inline" ? "active" : "inactive",
    description: "Launch this app inline in the main window",
    getValue: () => config.launchMode === "inline",
    onActivate: () => {
      if (supportsInline) updateConfig({ launchMode: "inline" });
    },
  });
  const alwaysOnTopToggle = useAgentElement<HTMLInputElement>({
    id: "always-on-top",
    role: "toggle",
    label: t("appdetails.keepOnTop", {
      defaultValue: "Keep this app's window on top",
    }),
    group: "app-launch",
    status: config.alwaysOnTop ? "active" : "inactive",
    description: "Keep this app's window above other windows",
    getValue: () => config.alwaysOnTop,
    onActivate: () => {
      if (config.launchMode === "window")
        updateConfig({ alwaysOnTop: !config.alwaysOnTop });
    },
  });

  if (catalogError && !resolved) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
        <TriangleAlert className="h-5 w-5 text-accent" />
        <span>{catalogError}</span>
      </div>
    );
  }
  if (!resolved && catalogLoading) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center text-sm text-muted">
        {t("appdetails.loadingSlug", {
          slug,
          defaultValue: "Loading {{slug}}…",
        })}
      </div>
    );
  }
  if (!resolved) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
        <TriangleAlert className="h-5 w-5 text-accent" />
        <span>
          {t("appdetails.appNotFound", {
            slug,
            defaultValue: "App not found: {{slug}}",
          })}
        </span>
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
  const provenanceBadges = appProvenanceBadges(resolved.info, t);
  const launchModeLabel =
    config.launchMode === "inline" && supportsInlineMode
      ? t("appdetails.mainWindow", { defaultValue: "Main window" })
      : t("appdetails.dedicatedWindow", { defaultValue: "Dedicated window" });

  return (
    <div className="device-layout mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 lg:px-6">
      {/* Header — flat, no divider. Sections separate by whitespace. */}
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-4">
          {resolved.info.heroImage ? (
            <img
              src={resolveRuntimeImageUrl(resolved.info.heroImage)}
              alt=""
              className="h-14 w-14 rounded-sm object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-sm bg-surface text-xs uppercase text-muted">
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
              <span>{sourceLabel(resolved.source, t)}</span>
              {provenanceBadges.map((badge) => (
                <span
                  key={badge.key}
                  title={badge.title}
                  className={badge.className}
                >
                  {badge.label}
                </span>
              ))}
              {recentRuns.length > 0 ? (
                <span className="text-accent">
                  {t("appdetails.runningCount", {
                    count: recentRuns.length,
                    defaultValue: "{{count}} running",
                  })}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {/* Flat — no card/border. The shell owns the page's horizontal padding. */}
      <section data-testid="app-launch-panel" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <SectionHeader>
              {t("appdetails.launch", { defaultValue: "Launch" })}
            </SectionHeader>
            <p className="text-xs text-muted">
              {activeRun
                ? t("appdetails.runStatus", {
                    name: activeRun.displayName,
                    status: activeRun.status,
                    defaultValue: "{{name}} is {{status}}.",
                  })
                : t("appdetails.readyToLaunch", {
                    defaultValue: "Ready to launch.",
                  })}
            </p>
          </div>
          <Button
            ref={launchButton.ref}
            onClick={handleLaunch}
            disabled={launching}
            title={t("appdetails.launchTitle", {
              name: resolved.info.displayName ?? resolved.info.name,
              defaultValue: "Launch {{name}}",
            })}
            className="max-w-full gap-2 rounded-full bg-accent px-5 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            {...launchButton.agentProps}
          >
            <Rocket className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {launching
                ? t("appdetails.launching", { defaultValue: "Launching..." })
                : t("appdetails.launch", { defaultValue: "Launch" })}
            </span>
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              {t("appdetails.statRun", { defaultValue: "Run" })}
            </div>
            <div className="truncate text-sm font-medium text-foreground">
              {activeRun?.status ??
                t("appdetails.statReady", { defaultValue: "Ready" })}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              {t("appdetails.statWindow", { defaultValue: "Window" })}
            </div>
            <div className="truncate text-sm font-medium text-foreground">
              {launchModeLabel}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              {t("appdetails.statTarget", { defaultValue: "Target" })}
            </div>
            <div
              className="truncate text-sm font-medium text-foreground"
              title={launchTarget}
            >
              {viewerUrl
                ? t("appdetails.targetViewer", { defaultValue: "Viewer" })
                : t("appdetails.targetAppRoute", { defaultValue: "App route" })}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              {t("appdetails.statSession", { defaultValue: "Session" })}
            </div>
            <div className="truncate text-sm font-medium text-foreground">
              {sessionMode
                ? formatLabel(sessionMode)
                : t("appdetails.sessionNotDeclared", {
                    defaultValue: "Not declared",
                  })}
            </div>
          </div>
        </div>

        {sessionFeatures.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {sessionFeatures.map((feature) => (
              <span key={feature} className="text-xs text-muted">
                {formatLabel(feature)}
              </span>
            ))}
          </div>
        ) : null}

        {latestFailure ? (
          <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-muted">
            <span className="font-medium text-destructive">
              {t("appdetails.lastFailure", { defaultValue: "Last failure: " })}
            </span>
            {latestFailure.errorMessage ??
              t("appdetails.launchFailedShort", {
                defaultValue: "Launch failed.",
              })}
          </div>
        ) : null}

        {/* Flat — no fieldset box; the legend reads as a plain group label. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs uppercase tracking-[0.14em] text-muted">
            <SettingsIcon className="mr-1 inline h-3 w-3" />{" "}
            {t("appdetails.launchDestination", {
              defaultValue: "Launch Destination",
            })}
          </legend>
          <label
            htmlFor="app-details-launch-mode-window"
            className="flex cursor-pointer items-center gap-2 text-sm"
          >
            <Input
              id="app-details-launch-mode-window"
              ref={launchModeWindowRadio.ref}
              type="radio"
              checked={config.launchMode === "window"}
              onChange={() => updateConfig({ launchMode: "window" })}
              className="h-3.5 w-3.5 border-border p-0 accent-accent"
              {...launchModeWindowRadio.agentProps}
            />
            <span>
              {t("appdetails.dedicatedWindow", {
                defaultValue: "Dedicated window",
              })}
            </span>
          </label>
          <label
            htmlFor="app-details-launch-mode-inline"
            className={`flex items-center gap-2 text-sm ${
              supportsInlineMode
                ? "cursor-pointer"
                : "cursor-not-allowed opacity-50"
            }`}
          >
            <Input
              id="app-details-launch-mode-inline"
              ref={launchModeInlineRadio.ref}
              type="radio"
              checked={config.launchMode === "inline"}
              disabled={!supportsInlineMode}
              onChange={() => updateConfig({ launchMode: "inline" })}
              className="h-3.5 w-3.5 border-border p-0 accent-accent"
              {...launchModeInlineRadio.agentProps}
            />
            <span>
              {!supportsInlineMode
                ? t("appdetails.mainWindowNotSupported", {
                    defaultValue: "Main window (not supported)",
                  })
                : t("appdetails.mainWindow", { defaultValue: "Main window" })}
            </span>
          </label>
        </fieldset>

        <label
          htmlFor="app-details-always-on-top"
          className={`inline-flex items-center gap-2 self-start text-xs ${
            config.launchMode === "window"
              ? "cursor-pointer"
              : "cursor-not-allowed opacity-50"
          }`}
        >
          <Input
            id="app-details-always-on-top"
            ref={alwaysOnTopToggle.ref}
            type="checkbox"
            checked={config.alwaysOnTop}
            disabled={config.launchMode !== "window"}
            onChange={(event) =>
              updateConfig({ alwaysOnTop: event.currentTarget.checked })
            }
            className="h-3.5 w-3.5 border-border p-0 accent-accent"
            {...alwaysOnTopToggle.agentProps}
          />
          {config.alwaysOnTop ? (
            <Pin className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>
            {t("appdetails.keepOnTop", {
              defaultValue: "Keep this app's window on top",
            })}
          </span>
        </label>
      </section>

      {/* Description + Capabilities */}
      <section className="flex flex-col gap-3">
        <SectionHeader>
          {t("appdetails.about", { defaultValue: "About" })}
        </SectionHeader>
        {resolved.info.description ? (
          <p className="text-sm text-muted">{resolved.info.description}</p>
        ) : null}
        <ChipList items={resolved.info.capabilities ?? []} t={t} />
      </section>

      {DetailExtension ? (
        <section className="flex flex-col gap-3">
          <SectionHeader>
            {t("appdetails.details", { defaultValue: "Details" })}
          </SectionHeader>
          <DetailExtension app={resolved.info} />
        </section>
      ) : null}

      {/* Recent runs */}
      {recentRuns.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeader>
            {t("appdetails.recentRuns", { defaultValue: "Recent Runs" })}
          </SectionHeader>
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {recentRuns.map((run) => (
              /* Flat — no card/border. Rows separate by whitespace. */
              <li
                key={run.runId}
                className="flex items-center justify-between py-1"
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
        <SectionHeader>
          {t("appdetails.launchDiagnostics", {
            defaultValue: "Launch Diagnostics",
          })}
        </SectionHeader>
        {history.length === 0 ? (
          <p className="text-xs text-muted">
            {t("appdetails.noLaunchHistory", {
              defaultValue: "No launch history yet.",
            })}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {history.slice(0, 5).map((entry) => (
              /* Flat — no card/border. Rows separate by whitespace. */
              <li key={entry.timestamp} className="py-1">
                <div className="flex items-center justify-between">
                  <span className="text-muted">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                  <span
                    className={
                      entry.succeeded ? "text-accent" : "text-destructive"
                    }
                  >
                    {entry.succeeded
                      ? t("appdetails.diagOk", { defaultValue: "OK" })
                      : t("appdetails.diagFailed", { defaultValue: "FAILED" })}
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
          <SectionHeader>
            {t("appdetails.widgets", { defaultValue: "Widgets" })}
          </SectionHeader>
          <ul className="flex flex-col gap-2">
            {widgets.map((decl) => {
              const visible = isWidgetVisible(decl, visibility.overrides);
              const widgetKey = widgetVisibilityKey(decl.pluginId, decl.id);
              const expanded = expandedWidget === widgetKey;
              return (
                <WidgetRow
                  key={widgetKey}
                  declaration={decl}
                  pluginId={resolved.pluginId}
                  visible={visible}
                  expanded={expanded}
                  onTogglePreview={() =>
                    setExpandedWidget(expanded ? null : widgetKey)
                  }
                  onToggleVisible={(enabled) => toggleWidget(decl, enabled)}
                  t={t}
                />
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
