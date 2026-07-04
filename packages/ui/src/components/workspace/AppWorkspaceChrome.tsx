/**
 * Provides the routed app workspace chrome that stacks optional navigation over
 * the main pane while leaving chat to the global shell overlay.
 */
import type React from "react";
import type { ReactNode } from "react";
import { useMediaQuery } from "../../hooks";

const WORKSPACE_MOBILE_MEDIA_QUERY = "(max-width: 819px)";

export interface AppWorkspaceChromeProps {
  /** Optional nav region rendered above the main pane. */
  nav?: ReactNode;
  /** Required main content area. */
  main: ReactNode;
  /** data-testid applied to the root element. */
  testId?: string;
  /**
   * Background surface for the chrome's content pane.
   * - `"opaque"` (default): a solid `bg-bg` panel — the right choice for the
   *   majority of routed views, which own their full surface.
   * - `"transparent"`: paints no background, so the unified app wallpaper
   *   (mounted once at the shell root) shows through — used by views that opt
   *   into the shared background (e.g. Settings), matching the launcher.
   *   Readability over an arbitrary wallpaper is handled by the shell's
   *   translucent scrim layer, not by this pane.
   */
  surface?: "opaque" | "transparent";
}

/**
 * Pure-layout workspace chrome: an optional nav region above the main content
 * pane. There is exactly one chat surface in the app — the global floating
 * overlay — so the chrome carries no chat rail of its own (single codepath,
 * per the architecture rules).
 *
 * The chrome renders NO mobile sidebar strip. The old top-of-pane
 * `MobileWorkspaceSidebarSwitcher` (an orphan icon button floating above every
 * view's own header) is gone: on mobile each `PageLayout` renders its own
 * labeled drawer trigger (`page-layout-mobile-sidebar-trigger`). Views with a
 * `ViewHeader` move that trigger into the header's right slot via
 * `WorkspaceMobileSidebarScope` + `ViewHeaderSidebarTrigger`; views without
 * one keep the inline trigger inside the view content.
 */
export function AppWorkspaceChrome({
  nav,
  main,
  testId = "app-workspace-chrome",
  surface = "opaque",
}: AppWorkspaceChromeProps): React.JSX.Element {
  const isMobileViewport = useMediaQuery(WORKSPACE_MOBILE_MEDIA_QUERY);

  return (
    <div
      className={`flex min-h-0 min-w-0 w-full flex-1 ${
        surface === "transparent" ? "" : "bg-bg"
      } pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px))] ${
        isMobileViewport ? "flex-col" : ""
      }`}
      data-testid={testId}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {nav}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {main}
        </div>
      </div>
    </div>
  );
}
