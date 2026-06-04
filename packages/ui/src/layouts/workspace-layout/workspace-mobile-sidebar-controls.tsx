/**
 * Compatibility re-export. The context object, hook, and types live in
 * `./workspace-mobile-sidebar-controls.hooks` so importers stay React Fast
 * Refresh-compatible. Kept so the `workspace-layout` barrel resolves unchanged.
 */
export {
  useWorkspaceMobileSidebarControls,
  type WorkspaceMobileSidebarControl,
  type WorkspaceMobileSidebarControls,
  WorkspaceMobileSidebarControlsContext,
} from "./workspace-mobile-sidebar-controls.hooks";
