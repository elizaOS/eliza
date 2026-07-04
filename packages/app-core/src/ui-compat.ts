// Legacy UI-compat shim, reachable only via the explicit `./ui-compat`
// package.json subpath (no longer via the Node `index.ts` barrel). View-bundle
// browser consumers (e.g. plugin-feed) externalize `@elizaos/ui`, so the React
// value re-exports below resolve to the host React singleton at runtime.
//
// The registry functions and surface helpers now live in the React-free
// `@elizaos/shared` package; the typed HTTP client + Feed transport types come
// from the React-free `@elizaos/ui/api` subpath. Only the primitive/component
// re-exports still touch the React component graph.

export type {
  AppDetailExtensionProps,
  OverlayApp,
  OverlayAppContext,
  SurfaceTone,
} from "@elizaos/shared";
export {
  formatDetailTimestamp,
  registerDetailExtension,
  registerOverlayApp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "@elizaos/shared";
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
} from "@elizaos/ui/api";
export { client } from "@elizaos/ui/api";
export {
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
} from "@elizaos/ui/components/apps/extensions/surface";
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
