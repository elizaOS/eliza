import { pathForTab } from "../navigation";
import type { HistoryLike } from "./types";

export type DetachedSurfaceTab =
  | "browser"
  | "chat"
  | "release"
  | "triggers"
  | "plugins"
  | "cloud";

export type WindowShellRoute =
  | { mode: "main" }
  | { mode: "settings"; tab?: string }
  | { mode: "surface"; tab: DetachedSurfaceTab }
  | { mode: "chat-overlay" }
  | { mode: "onboarding-overlay" };

export interface DetachedShellTarget {
  settingsSection?: string;
  tab: "browser" | "chat" | "plugins" | "settings" | "triggers";
}

export function parseWindowShellRoute(search: string): WindowShellRoute {
  const params = new URLSearchParams(search);
  const shell = params.get("shell");
  const shellMode = params.get("shellMode") ?? params.get("shell-mode");

  if (shellMode === "chat-overlay") {
    return { mode: "chat-overlay" };
  }

  if (shellMode === "onboarding-overlay") {
    return { mode: "onboarding-overlay" };
  }

  if (shell === "settings") {
    const tab = params.get("tab")?.trim() || undefined;
    return tab ? { mode: "settings", tab } : { mode: "settings" };
  }

  if (shell === "surface") {
    const tab = params.get("tab");
    if (
      tab === "browser" ||
      tab === "chat" ||
      tab === "release" ||
      tab === "triggers" ||
      tab === "plugins" ||
      tab === "cloud"
    ) {
      return { mode: "surface", tab };
    }
  }

  return { mode: "main" };
}

export function resolveWindowShellRoute(
  search = typeof window !== "undefined" ? window.location.search : "",
): WindowShellRoute {
  return parseWindowShellRoute(search);
}

export function isDetachedWindowShell(
  route: WindowShellRoute,
): route is Exclude<
  WindowShellRoute,
  { mode: "main" } | { mode: "chat-overlay" } | { mode: "onboarding-overlay" }
> {
  return (
    route.mode !== "main" &&
    route.mode !== "chat-overlay" &&
    route.mode !== "onboarding-overlay"
  );
}

export function isChatOverlayWindowShell(
  route: WindowShellRoute,
): route is Extract<WindowShellRoute, { mode: "chat-overlay" }> {
  return route.mode === "chat-overlay";
}

export function isOnboardingOverlayWindowShell(
  route: WindowShellRoute,
): route is Extract<WindowShellRoute, { mode: "onboarding-overlay" }> {
  return route.mode === "onboarding-overlay";
}

export function isStandaloneWindowShell(
  route: WindowShellRoute,
): route is Exclude<WindowShellRoute, { mode: "main" }> {
  return route.mode !== "main";
}

export function shouldInstallMainWindowFirstRunPatches(
  route: WindowShellRoute,
): boolean {
  return route.mode === "main";
}

export function resolveDetachedShellTarget(
  route: WindowShellRoute,
): DetachedShellTarget {
  if (route.mode === "main") {
    throw new Error("Main windows do not have a detached shell target");
  }

  if (route.mode === "chat-overlay" || route.mode === "onboarding-overlay") {
    throw new Error(
      `${route.mode} windows do not have a detached shell target`,
    );
  }

  if (route.mode === "settings") {
    return { tab: "settings", settingsSection: route.tab };
  }

  switch (route.tab) {
    case "browser":
      return { tab: "browser" };
    case "chat":
      return { tab: "chat" };
    case "release":
      return { tab: "settings", settingsSection: "updates" };
    case "triggers":
      return { tab: "triggers" };
    case "plugins":
      return { tab: "plugins" };
    case "cloud":
      return { tab: "settings", settingsSection: "cloud" };
  }
}

export function resolveDetachedShellPathname(route: WindowShellRoute): string {
  const target = resolveDetachedShellTarget(route);
  return pathForTab(target.tab);
}

export function syncDetachedShellLocation(
  route: WindowShellRoute,
  args?: {
    history?: HistoryLike | null;
    href?: string;
  },
): boolean {
  if (
    route.mode === "main" ||
    route.mode === "chat-overlay" ||
    route.mode === "onboarding-overlay"
  ) {
    return false;
  }

  const href =
    args?.href ?? (typeof window !== "undefined" ? window.location.href : null);
  const history =
    args?.history ?? (typeof window !== "undefined" ? window.history : null);

  if (!href || !history) {
    return false;
  }

  const nextUrl = new URL(href);
  nextUrl.pathname = resolveDetachedShellPathname(route);
  history.replaceState(null, "", nextUrl.toString());
  return true;
}
