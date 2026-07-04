/**
 * App detail-surface helpers.
 *
 * The pure helper functions and the `SelectedAppRun` / `SurfaceTone` types now
 * live in `@elizaos/shared` (`contracts/app-surface-helpers`) so the Node
 * runtime can use them without dragging the React component graph in. This
 * module re-exports them so existing browser importers keep working unchanged.
 */

export {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "@elizaos/shared";
