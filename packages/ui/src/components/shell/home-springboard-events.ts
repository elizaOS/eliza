export const HOME_SPRINGBOARD_NAV_EVENT = "eliza:home-springboard:navigate";

export type HomeSpringboardPage = "home" | "springboard";

export interface HomeSpringboardNavigationDetail {
  page: HomeSpringboardPage;
}

export function dispatchHomeSpringboardNavigation(
  page: HomeSpringboardPage,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<HomeSpringboardNavigationDetail>(
      HOME_SPRINGBOARD_NAV_EVENT,
      { detail: { page } },
    ),
  );
}
