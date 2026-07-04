// React-free re-export of the typed HTTP client + Feed transport types from the
// `@elizaos/ui/api` subpath (which has zero React imports). This keeps `client`
// and the Feed transport types reachable from the Node `@elizaos/app-core`
// barrel — plugin view bundles (e.g. plugin-polymarket, plugin-hyperliquid)
// import `{ client }` from the bare barrel and resolve it against the built
// `dist/index.d.ts` at typecheck time — without dragging the React component
// graph into the API process the way the root `@elizaos/ui` barrel would.
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
