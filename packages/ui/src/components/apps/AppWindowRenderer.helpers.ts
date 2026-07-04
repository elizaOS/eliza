/**
 * Builds and memoizes the lazily-loaded component for an overlay app, wrapping
 * its loader in a `RetainedLazyComponent` (so the module stays warm across
 * remounts) with shared loading/error fallbacks. Results are cached per loader
 * in a `WeakMap` so repeated renders of the same app reuse one lazy component.
 */

import { type ComponentType, createElement } from "react";
import { RetainedLazyComponent } from "../../retained-lazy";
import {
  navigateToViews,
  ViewErrorState,
  ViewLoadingSkeleton,
} from "../views/ViewStatusStates";
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
      cacheKey: app.name,
      componentProps: props,
      // A failed overlay-app import (bundle 404 / network error / a module with
      // no renderable default export) must surface the SAME recoverable
      // "Failed to load view" card as a remote view — never a blank/white
      // screen. `fallback` covers the loading gap; `onError` renders the card
      // with a Retry that re-imports and a Back that exits the overlay.
      fallback: createElement(ViewLoadingSkeleton),
      onError: (error, retry) =>
        createElement(ViewErrorState, {
          viewId: app.name,
          error,
          onRetry: retry,
          onBack: props.exitToApps ?? navigateToViews,
        }),
    });
  };
  lazyComponentCache.set(app.loader, created);
  return created;
}
