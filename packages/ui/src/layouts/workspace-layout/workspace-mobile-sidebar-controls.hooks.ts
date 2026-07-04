/**
 * Context + hooks for the mobile sidebar controls (open/close per control id)
 * shared between the layout and its drawer toggle.
 */
import * as React from "react";

export interface WorkspaceMobileSidebarControl {
  id: string;
  label?: React.ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
}

export interface WorkspaceMobileSidebarControls {
  register: (control: WorkspaceMobileSidebarControl) => () => void;
}

export const WorkspaceMobileSidebarControlsContext =
  React.createContext<WorkspaceMobileSidebarControls | null>(null);

export function useWorkspaceMobileSidebarControls(): WorkspaceMobileSidebarControls | null {
  return React.useContext(WorkspaceMobileSidebarControlsContext);
}

export interface WorkspaceMobileSidebarHeaderState {
  /**
   * Context value — provide it (via `WorkspaceMobileSidebarScope`) around the
   * PageLayout/WorkspaceLayout that owns the sidebar. Any mobile drawer inside
   * the scope suppresses its inline content-flow trigger and registers itself
   * here instead.
   */
  controls: WorkspaceMobileSidebarControls;
  /**
   * The registered mobile drawer, or null when none is mounted (desktop
   * viewport, or a layout without a sidebar). Feed it to
   * `ViewHeaderSidebarTrigger` in the view header's `right` slot.
   */
  control: WorkspaceMobileSidebarControl | null;
}

/**
 * Owns the header-side state for a view that moves its mobile sidebar trigger
 * out of the content flow and into its `ViewHeader`. The drawer registers via
 * the returned `controls` context value; the first registered drawer is
 * exposed as `control` for the header trigger.
 */
export function useWorkspaceMobileSidebarHeader(): WorkspaceMobileSidebarHeaderState {
  const [registered, setRegistered] = React.useState<
    WorkspaceMobileSidebarControl[]
  >([]);
  const controls = React.useMemo<WorkspaceMobileSidebarControls>(
    () => ({
      register: (control) => {
        setRegistered((prev) => {
          const index = prev.findIndex((item) => item.id === control.id);
          if (index === -1) return [...prev, control];
          const next = prev.slice();
          next[index] = control;
          return next;
        });
        return () => {
          setRegistered((prev) =>
            prev.filter((item) => item.id !== control.id),
          );
        };
      },
    }),
    [],
  );
  return { controls, control: registered[0] ?? null };
}
