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
export declare const WorkspaceMobileSidebarControlsContext: React.Context<WorkspaceMobileSidebarControls | null>;
export declare function useWorkspaceMobileSidebarControls(): WorkspaceMobileSidebarControls | null;
//# sourceMappingURL=workspace-mobile-sidebar-controls.d.ts.map