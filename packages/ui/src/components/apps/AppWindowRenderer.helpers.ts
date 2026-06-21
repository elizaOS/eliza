import { type ComponentType, createElement } from "react";
import { RetainedLazyComponent } from "../../retained-lazy";
import type { OverlayApp, OverlayAppContext } from "./overlay-app-api";

const lazyComponentCache = new WeakMap<
  NonNullable<OverlayApp["loader"]>,
  ComponentType<OverlayAppContext>
>();

export function getOverlayAppLazyComponent(
  app: OverlayApp,
): ComponentType<OverlayAppContext> | null {
  if (!app.loader) return null;
  const existing = lazyComponentCache.get(app.loader);
  if (existing) return existing;
  const loader = app.loader;
  const created = function RetainedOverlayApp(props: OverlayAppContext) {
    return createElement(RetainedLazyComponent<OverlayAppContext>, {
      loader,
      componentProps: props,
      fallback: null,
    });
  };
  lazyComponentCache.set(app.loader, created);
  return created;
}
