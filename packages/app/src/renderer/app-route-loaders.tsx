import {
  loadAutomationsFeed,
  loadBackgroundView,
  loadBrowserWorkspaceView,
  loadCameraPageView,
  loadCharacterEditor,
  loadCharacterExperienceView,
  loadCharacterSkillsView,
  loadClockView,
  loadDatabasePageView,
  loadDesktopWorkspaceSection,
  loadFilesView,
  loadLiveMeetingPage,
  loadLogsView,
  loadMemoryViewerView,
  loadPluginsPageView,
  loadRuntimeView,
  loadSettingsView,
  loadSkillsView,
  loadStreamView,
  loadTasksPageView,
  loadTrajectoriesView,
  loadVaultPageView,
} from "@elizaos/ui";

/**
 * Lazy route registry for the app shell. It owns chunk registration, bounded
 * idle prefetch, and the shared loading boundary so App only composes routes.
 */

import { reportRendererDiagnostic } from "@elizaos/ui";
import {
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
} from "react";

type ExtractComponent<TValue> =
  TValue extends ComponentType<infer Props> ? ComponentType<Props> : never;

const routeViewLoaders = new Set<() => Promise<unknown>>();

function lazyNamedView<
  TModule extends Record<string, unknown>,
  TKey extends keyof TModule,
>(
  load: () => Promise<TModule>,
  exportName: TKey,
): LazyExoticComponent<ExtractComponent<TModule[TKey]>> {
  routeViewLoaders.add(load);
  return lazy(async () => {
    const module = await load();
    const component = module[exportName];
    if (typeof component !== "function") {
      throw new Error(`Missing component export: ${String(exportName)}`);
    }
    return { default: component as ExtractComponent<TModule[TKey]> };
  });
}

export const LazyBackgroundView = lazyNamedView(
  loadBackgroundView,
  "BackgroundView",
);
export const LazyCharacterEditor = lazyNamedView(
  loadCharacterEditor,
  "CharacterEditor",
);
export const LazyClockView = lazyNamedView(loadClockView, "ClockView");
export const LazyAutomationsFeed = lazyNamedView(
  loadAutomationsFeed,
  "AutomationsFeed",
);
export const LazyBrowserWorkspaceView = lazyNamedView(
  loadBrowserWorkspaceView,
  "BrowserWorkspaceView",
);
export const LazyLiveMeetingPageView = lazyNamedView(
  loadLiveMeetingPage,
  "LiveMeetingPage",
);
export const LazyCameraPageView = lazyNamedView(
  loadCameraPageView,
  "CameraPageView",
);
export const LazyDesktopWorkspaceSection = lazyNamedView(
  loadDesktopWorkspaceSection,
  "DesktopWorkspaceSection",
);
export const LazySettingsView = lazyNamedView(loadSettingsView, "SettingsView");
export const LazyVaultPageView = lazyNamedView(
  loadVaultPageView,
  "VaultPageView",
);
export const LazyStreamView = lazyNamedView(loadStreamView, "StreamView");
export const LazyDatabasePageView = lazyNamedView(
  loadDatabasePageView,
  "DatabasePageView",
);
export const LazyFilesView = lazyNamedView(loadFilesView, "FilesView");
export const LazyLogsView = lazyNamedView(loadLogsView, "LogsView");
export const LazyMemoryViewerView = lazyNamedView(
  loadMemoryViewerView,
  "MemoryViewerView",
);
export const LazyPluginsPageView = lazyNamedView(
  loadPluginsPageView,
  "PluginsPageView",
);
export const LazyCharacterExperienceView = lazyNamedView(
  loadCharacterExperienceView,
  "CharacterExperienceView",
);
export const LazyCharacterSkillsView = lazyNamedView(
  loadCharacterSkillsView,
  "CharacterSkillsView",
);
export const LazyRuntimeView = lazyNamedView(loadRuntimeView, "RuntimeView");
export const LazySkillsView = lazyNamedView(loadSkillsView, "SkillsView");
export const LazyTasksPageView = lazyNamedView(
  loadTasksPageView,
  "TasksPageView",
);
export const LazyTrajectoriesView = lazyNamedView(
  loadTrajectoriesView,
  "TrajectoriesView",
);

const ROUTE_PREFETCH_MAX_CHUNKS = 4;

function shouldWarmRouteViewChunks(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  if (document.visibilityState === "hidden") return false;
  const navigatorWithHints = navigator as Navigator & {
    connection?: { effectiveType?: string; saveData?: boolean };
    deviceMemory?: number;
  };
  if (navigatorWithHints.connection?.saveData) return false;
  if (
    ["slow-2g", "2g"].includes(
      navigatorWithHints.connection?.effectiveType ?? "",
    )
  ) {
    return false;
  }
  return !(
    typeof navigatorWithHints.deviceMemory === "number" &&
    navigatorWithHints.deviceMemory <= 4
  );
}

export function scheduleRouteViewChunkPrefetch(): () => void {
  if (!shouldWarmRouteViewChunks()) return () => {};
  const loaders = [...routeViewLoaders].slice(0, ROUTE_PREFETCH_MAX_CHUNKS);
  if (loaders.length === 0) return () => {};
  let cancelled = false;
  let scheduledId: number | null = null;
  const browserWindow = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout?: number },
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };

  const scheduleNext = () => {
    if (cancelled || loaders.length === 0) return;
    const run = () => {
      scheduledId = null;
      if (cancelled) return;
      const load = loaders.shift();
      if (load) {
        void load().catch((error) => {
          // error-policy:J7 a speculative fetch cannot block the idle queue;
          // navigation retries the chunk and this records the early failure.
          reportRendererDiagnostic({
            scope: "app-routes.prefetch",
            error,
            severity: "warning",
          });
        });
      }
      scheduleNext();
    };
    scheduledId =
      browserWindow.requestIdleCallback?.(run, { timeout: 2_000 }) ??
      window.setTimeout(run, 750);
  };

  scheduleNext();
  return () => {
    cancelled = true;
    if (scheduledId === null) return;
    if (browserWindow.cancelIdleCallback) {
      browserWindow.cancelIdleCallback(scheduledId);
    } else {
      window.clearTimeout(scheduledId);
    }
  };
}

export function LazyViewBoundary({ children }: { children: ReactNode }) {
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
