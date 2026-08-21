/**
 * Lazy route registry for the app shell. It owns chunk registration, bounded
 * idle prefetch, and the shared loading boundary so App only composes routes.
 */

import {
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
} from "react";
import { reportRendererDiagnostic } from "./utils/renderer-diagnostics";

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
  () => import("./components/pages/BackgroundView"),
  "BackgroundView",
);
export const LazyCharacterEditor = lazyNamedView(
  () => import("./components/character/CharacterEditor"),
  "CharacterEditor",
);
export const LazyAutomationsFeed = lazyNamedView(
  () => import("./components/pages/AutomationsFeed"),
  "AutomationsFeed",
);
export const LazyBrowserWorkspaceView = lazyNamedView(
  () => import("./components/pages/BrowserWorkspaceView"),
  "BrowserWorkspaceView",
);
export const LazyLiveMeetingPageView = lazyNamedView(
  () => import("./components/transcripts/LiveMeetingPage"),
  "LiveMeetingPage",
);
export const LazyCameraPageView = lazyNamedView(
  () => import("./components/pages/CameraPageView"),
  "CameraPageView",
);
export const LazyContactsPageView = lazyNamedView(
  () => import("./components/pages/ElizaOsAppsView"),
  "ContactsPageView",
);
export const LazyDesktopWorkspaceSection = lazyNamedView(
  () => import("./components/settings/DesktopWorkspaceSection"),
  "DesktopWorkspaceSection",
);
export const LazyMessagesPageView = lazyNamedView(
  () => import("./components/pages/ElizaOsAppsView"),
  "MessagesPageView",
);
export const LazyPhonePageView = lazyNamedView(
  () => import("./components/pages/ElizaOsAppsView"),
  "PhonePageView",
);
export const LazySettingsView = lazyNamedView(
  () => import("./components/pages/SettingsView"),
  "SettingsView",
);
export const LazyStreamView = lazyNamedView(
  () => import("./components/pages/StreamView"),
  "StreamView",
);
export const LazyPendantTranscriptView = lazyNamedView(
  () => import("./components/pages/PendantTranscriptView"),
  "PendantTranscriptView",
);
export const LazyDatabasePageView = lazyNamedView(
  () => import("./components/pages/DatabasePageView"),
  "DatabasePageView",
);
export const LazyFilesView = lazyNamedView(
  () => import("./components/pages/FilesView"),
  "FilesView",
);
export const LazyLogsView = lazyNamedView(
  () => import("./components/pages/LogsView"),
  "LogsView",
);
export const LazyMemoryViewerView = lazyNamedView(
  () => import("./components/pages/MemoryViewerView"),
  "MemoryViewerView",
);
export const LazyPluginsPageView = lazyNamedView(
  () => import("./components/pages/PluginsPageView"),
  "PluginsPageView",
);
export const LazyRelationshipsView = lazyNamedView(
  () => import("./components/pages/RelationshipsView"),
  "RelationshipsView",
);
export const LazyKnowledgeView = lazyNamedView(
  () => import("./components/pages/KnowledgeView"),
  "KnowledgeView",
);
export const LazyCharacterExperienceView = lazyNamedView(
  () => import("./components/character/CharacterExperienceView"),
  "CharacterExperienceView",
);
export const LazyCharacterSkillsView = lazyNamedView(
  () => import("./components/character/CharacterSkillsView"),
  "CharacterSkillsView",
);
export const LazyRuntimeView = lazyNamedView(
  () => import("./components/pages/RuntimeView"),
  "RuntimeView",
);
export const LazySkillsView = lazyNamedView(
  () => import("./components/pages/SkillsView"),
  "SkillsView",
);
export const LazyTasksPageView = lazyNamedView(
  () => import("./components/pages/TasksPageView"),
  "TasksPageView",
);
export const LazyTrajectoriesView = lazyNamedView(
  () => import("./components/pages/TrajectoriesView"),
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
