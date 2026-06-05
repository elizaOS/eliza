import { type ComponentType, lazy } from "react";
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
  const created = lazy(app.loader);
  lazyComponentCache.set(app.loader, created);
  return created;
}
