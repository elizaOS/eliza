/**
 * Designed not-found state for an unclaimed `/apps/<slug>` route: nothing in
 * the view registry, app-shell page registry, or active app runs serves the
 * slug on this device. AppsPageView renders it instead of the healthy launcher
 * grid (UI three-state rule — a dead deep link must never render as healthy),
 * offering the view's canonical home when the slug matches a view id mounted
 * elsewhere (a stale bookmark), and the launcher as the general way back.
 */
import type * as React from "react";
import { navigateBrowserPath } from "../../app-navigate-view";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";

export interface AppRouteNotFoundMatchedView {
  label: string;
  path: string;
}

export interface AppRouteNotFoundProps {
  slug: string;
  /** Routable view whose id equals the slug but whose canonical path is elsewhere. */
  matchedView?: AppRouteNotFoundMatchedView | null;
  /** Navigation seam for tests; defaults to real browser navigation. */
  navigatePath?: (path: string) => void;
}

export function AppRouteNotFound({
  slug,
  matchedView = null,
  navigatePath = navigateBrowserPath,
}: AppRouteNotFoundProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-testid="app-route-not-found"
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <p className="text-xs-tight uppercase tracking-[0.24em] text-muted">
        {t("appRouteNotFound.kicker", { defaultValue: "Nothing mounted here" })}
      </p>
      <code className="rounded-sm bg-bg-hover px-2 py-1 font-mono text-sm text-txt-strong">
        /apps/{slug}
      </code>
      <p className="max-w-sm text-sm leading-6 text-muted">
        {t("appRouteNotFound.body", {
          defaultValue:
            "No app or view is mounted at this address on this device.",
        })}
      </p>
      <div className="mt-2 flex flex-col items-center gap-2">
        {matchedView ? (
          <Button
            data-testid="app-route-not-found-open-view"
            onClick={() => navigatePath(matchedView.path)}
          >
            {t("appRouteNotFound.openView", {
              defaultValue: "Open {{label}}",
              label: matchedView.label,
            })}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          data-testid="app-route-not-found-browse-apps"
          onClick={() => navigatePath("/apps")}
        >
          {t("appRouteNotFound.browseApps", { defaultValue: "Browse apps" })}
        </Button>
      </div>
    </div>
  );
}
