// Registration-surface contracts + registries (overlay apps, detail extensions)
// are owned by @elizaos/shared — the React-free canonical home — so this
// Node-reachable shim registers app surfaces without touching the React package.
export type {
  AppDetailExtensionProps,
  OverlayApp,
  OverlayAppContext,
} from "@elizaos/shared";
export { registerDetailExtension, registerOverlayApp } from "@elizaos/shared";
// Everything below re-exports from its narrow `@elizaos/ui` subpath rather than
// the root barrel. The barrel (`@elizaos/ui`) eagerly evaluates the entire
// frontend component graph, and this shim is reachable from the Node
// `@elizaos/app-core` barrel (index.ts) — so importing it from the bare barrel
// dragged ~1000 React modules (and their deps) into the API process at boot.
// Subpath imports pull only the specific component. Mirrors `browser.ts`.
export type {
  AppRunSummary,
  AppSessionJsonValue,
  FeedActivityItem,
  FeedAgentGoal,
  FeedAgentStatus,
  FeedChatMessage,
  FeedPredictionMarket,
  FeedTeamAgent,
  FeedWallet,
  SurfaceTone,
} from "@elizaos/ui";
export { client } from "@elizaos/ui/api";
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
export { PagePanel } from "@elizaos/ui/components/composites/page-panel";
export { Button } from "@elizaos/ui/components/ui/button";
export { Input } from "@elizaos/ui/components/ui/input";
export { Spinner } from "@elizaos/ui/components/ui/spinner";
// app-store only pulls React + an erased type (same weight as useApp), so it
// stays light enough for the Node API process — re-export the selector hooks so
// app plugins can subscribe to AppContext slices instead of the whole value.
export {
  useAppSelector,
  useAppSelectorShallow,
} from "@elizaos/ui/state/app-store";
export { useApp } from "@elizaos/ui/state/useApp";
