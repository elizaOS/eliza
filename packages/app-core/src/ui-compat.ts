export type {
  AppDetailExtensionProps,
  AppOperatorSurfaceProps,
  AppRunSummary,
  AppSessionJsonValue,
  FeedActivityItem,
  FeedAgentGoal,
  FeedAgentStatus,
  FeedChatMessage,
  FeedPredictionMarket,
  FeedTeamAgent,
  FeedWallet,
  GameOperatorAction,
  GameOperatorEvent,
  OverlayApp,
  OverlayAppContext,
  SurfaceTone,
} from "@elizaos/ui";
// Re-export each value from its narrow `@elizaos/ui` subpath rather than the
// root barrel. The barrel (`@elizaos/ui`) eagerly evaluates the entire frontend
// component graph, and this shim is reachable from the Node `@elizaos/app-core`
// barrel (index.ts) — so importing it from the bare barrel dragged ~1000 React
// modules (and their deps) into the API process at boot. Subpath imports pull
// only the specific component. Mirrors `browser.ts`. The `export type` block
// above is erased at compile time and needs no narrowing.
export { client } from "@elizaos/ui/api";
export { registerDetailExtension } from "@elizaos/ui/components/apps/extensions/registry";
export {
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
} from "@elizaos/ui/components/apps/extensions/surface";
export {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "@elizaos/ui/components/apps/extensions/surface.helpers";
export { registerOverlayApp } from "@elizaos/ui/components/apps/overlay-app-registry";
export { GameOperatorShell } from "@elizaos/ui/components/apps/surfaces/GameOperatorShell";
export { registerOperatorSurface } from "@elizaos/ui/components/apps/surfaces/registry";
export { PagePanel } from "@elizaos/ui/components/composites/page-panel";
export { Button } from "@elizaos/ui/components/ui/button";
export { Input } from "@elizaos/ui/components/ui/input";
export { Spinner } from "@elizaos/ui/components/ui/spinner";
export { useApp } from "@elizaos/ui/state/useApp";
