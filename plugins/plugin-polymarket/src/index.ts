/** Public barrel: re-exports the plugin, action, client, provider, view, and route surfaces. */
export * from "./actions";
export * from "./client";
export {
  derivePolymarketTopOfBook,
  type PolymarketTopOfBook,
} from "./orderbook";
export { PolymarketView } from "./PolymarketView";
export { polymarketPlugin } from "./plugin";
export * from "./polymarket-contracts";
export * from "./polymarket-view.helpers";
export { polymarketStatusProvider } from "./provider";
export * from "./register";
export * from "./routes";
export * from "./usePolymarketState";
