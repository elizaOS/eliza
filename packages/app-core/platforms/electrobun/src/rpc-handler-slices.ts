import type { DynamicViewRegistry } from "./dynamic-views/registry";
import type { DynamicViewSessionManager } from "./dynamic-views/session-manager";
import type {
  DynamicViewCloseParams,
  DynamicViewOpenParams,
  DynamicViewPushParams,
  DynamicViewRegisterParams,
  DynamicViewUnregisterParams,
} from "./dynamic-views/types";
import {
  isDetachedSurface,
  type ManagedWindowSnapshot,
} from "./surface-windows";

type DetachedWindowSurface =
  | "chat"
  | "browser"
  | "release"
  | "triggers"
  | "plugins"
  | "connectors"
  | "cloud";

interface WindowRpcDesktop {
  openSettings(tabHint?: string): void;
  openSurfaceWindow(
    surface: DetachedWindowSurface,
    browse?: string,
    alwaysOnTop?: boolean,
  ): Promise<ManagedWindowSnapshot>;
  openAppWindow(options: {
    slug?: string;
    title: string;
    path: string;
    alwaysOnTop?: boolean;
  }): Promise<ManagedWindowSnapshot>;
  setManagedWindowAlwaysOnTop(id: string, flag: boolean): boolean;
}

export function normalizeRendererRoutePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    throw new Error("desktopOpenAppWindow path must be a renderer route.");
  }
  return trimmed;
}

export function buildWindowRpcHandlers({
  desktop,
  appName,
}: {
  desktop: WindowRpcDesktop;
  appName: string;
}) {
  return {
    desktopOpenSettingsWindow: async (
      params: { tabHint?: string } | undefined,
    ) => {
      desktop.openSettings(params?.tabHint);
    },
    desktopOpenSurfaceWindow: async (params: {
      surface: DetachedWindowSurface;
      browse?: string;
      alwaysOnTop?: boolean;
    }) => {
      if (!isDetachedSurface(params.surface)) {
        return null;
      }
      return desktop.openSurfaceWindow(
        params.surface,
        params.surface === "browser" ? params.browse : undefined,
        params.alwaysOnTop === true,
      );
    },
    desktopOpenAppWindow: async (params: {
      slug?: string;
      title: string;
      path: string;
      alwaysOnTop?: boolean;
    }) =>
      desktop.openAppWindow({
        slug:
          typeof params.slug === "string" && params.slug.length > 0
            ? params.slug
            : undefined,
        title: params.title.trim() || appName,
        path: normalizeRendererRoutePath(params.path),
        alwaysOnTop: params.alwaysOnTop === true,
      }),
    desktopSetManagedWindowAlwaysOnTop: async (params: {
      id: string;
      flag: boolean;
    }) => ({
      success: desktop.setManagedWindowAlwaysOnTop(params.id, params.flag),
    }),
  };
}

export function buildDynamicViewRpcHandlers({
  registry,
  sessions,
}: {
  registry: DynamicViewRegistry;
  sessions: DynamicViewSessionManager;
}) {
  return {
    dynamicViewRegister: async (params: DynamicViewRegisterParams) =>
      registry.register(params.manifest, { update: params.update }),
    dynamicViewUnregister: async (params: DynamicViewUnregisterParams) => ({
      removed: registry.unregister(params.viewId),
    }),
    dynamicViewList: async () => ({ views: registry.list() }),
    dynamicViewOpen: async (params: DynamicViewOpenParams) =>
      sessions.open(params),
    dynamicViewClose: async (params: DynamicViewCloseParams) =>
      sessions.close(params),
    dynamicViewPush: async (params: DynamicViewPushParams) =>
      sessions.push(params),
    dynamicViewSessions: async () => ({
      sessions: sessions.list(),
    }),
  };
}
