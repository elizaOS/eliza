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
