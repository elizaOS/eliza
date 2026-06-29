export const HOME_LAUNCHER_NAV_EVENT = "eliza:home-launcher:navigate";

export type HomeLauncherPage = "home" | "launcher";

export interface HomeLauncherNavigationDetail {
  page: HomeLauncherPage;
}

export function dispatchHomeLauncherNavigation(page: HomeLauncherPage): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<HomeLauncherNavigationDetail>(HOME_LAUNCHER_NAV_EVENT, {
      detail: { page },
    }),
  );
}
