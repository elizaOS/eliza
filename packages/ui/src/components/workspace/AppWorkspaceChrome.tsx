import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type React from "react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useMediaQuery } from "../../hooks";
import {
  type WorkspaceMobileSidebarControl,
  type WorkspaceMobileSidebarControls,
  WorkspaceMobileSidebarControlsContext,
} from "../../layouts/workspace-layout/workspace-mobile-sidebar-controls.hooks";
import { Button } from "../ui/button";

const WORKSPACE_MOBILE_MEDIA_QUERY = "(max-width: 819px)";

/**
 * Mobile sidebar toggle. The right-side page-scoped chat rail was removed
 * (#8796): chat is the single global floating overlay (`ContinuousChatOverlay`),
 * so the chrome is just an optional nav + main + a mobile control that reveals
 * the left sidebar. The old in-chrome `ChatView` / `PageScopedChatPane` fallback
 * (a dead second chat path every caller disabled) is gone.
 */
function MobileWorkspaceSidebarSwitcher({
  sidebar,
  onSidebar,
  onCloseSidebar,
}: {
  sidebar: WorkspaceMobileSidebarControl;
  onSidebar: () => void;
  onCloseSidebar: () => void;
}): React.JSX.Element {
  const sidebarOpen = sidebar.open;
  return (
    <div
      className="flex shrink-0 items-center border-b border-border/35 bg-bg/92 px-2 py-1.5"
      data-testid="app-workspace-mobile-pane-switcher"
    >
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label={sidebarOpen ? "Hide left sidebar" : "Show left sidebar"}
        aria-pressed={sidebarOpen}
        title={sidebarOpen ? "Hide left sidebar" : "Show left sidebar"}
        data-testid="app-workspace-mobile-pane-left"
        onClick={sidebarOpen ? onCloseSidebar : onSidebar}
        className="h-9 w-9 rounded-sm border border-border/40 bg-card/80 text-muted transition-colors hover:text-txt"
      >
        {sidebarOpen ? (
          <PanelLeftClose className="h-4 w-4" aria-hidden />
        ) : (
          <PanelLeftOpen className="h-4 w-4" aria-hidden />
        )}
      </Button>
    </div>
  );
}

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
 * pane, plus a mobile control to reveal the left sidebar. There is exactly one
 * chat surface in the app — the global floating overlay — so the chrome carries
 * no chat rail of its own (single codepath, per the architecture rules).
 */
export function AppWorkspaceChrome({
  nav,
  main,
  testId = "app-workspace-chrome",
  surface = "opaque",
}: AppWorkspaceChromeProps): React.JSX.Element {
  const isMobileViewport = useMediaQuery(WORKSPACE_MOBILE_MEDIA_QUERY);
  const [mobileSidebarControl, setMobileSidebarControl] =
    useState<WorkspaceMobileSidebarControl | null>(null);

  const registerMobileSidebar = useCallback<
    WorkspaceMobileSidebarControls["register"]
  >((control) => {
    setMobileSidebarControl(control);
    return () => {
      setMobileSidebarControl((current) =>
        current?.id === control.id ? null : current,
      );
    };
  }, []);

  const mobileSidebarControlsValue = useMemo<WorkspaceMobileSidebarControls>(
    () => ({ register: registerMobileSidebar }),
    [registerMobileSidebar],
  );

  const handleOpenMobileSidebar = useCallback(() => {
    mobileSidebarControl?.setOpen(true);
  }, [mobileSidebarControl]);

  const handleCloseMobileSidebar = useCallback(() => {
    mobileSidebarControl?.setOpen(false);
  }, [mobileSidebarControl]);

  return (
    <WorkspaceMobileSidebarControlsContext.Provider
      value={mobileSidebarControlsValue}
    >
      <div
        className={`flex min-h-0 min-w-0 w-full flex-1 ${
          surface === "transparent" ? "" : "bg-bg"
        } pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px))] ${
          isMobileViewport ? "flex-col" : ""
        }`}
        data-testid={testId}
      >
        {isMobileViewport && mobileSidebarControl !== null ? (
          <MobileWorkspaceSidebarSwitcher
            sidebar={mobileSidebarControl}
            onSidebar={handleOpenMobileSidebar}
            onCloseSidebar={handleCloseMobileSidebar}
          />
        ) : null}

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {nav}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {main}
          </div>
        </div>
      </div>
    </WorkspaceMobileSidebarControlsContext.Provider>
  );
}
