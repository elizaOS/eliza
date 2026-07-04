/** Public package entry: registers the automation-node contributor as a side effect and re-exports the plugin, action, client, routes, and views. */
import { registerHyperliquidAutomationNodeContributor } from "./automation-node-contributor";

registerHyperliquidAutomationNodeContributor();

export * from "./actions/perpetual-market";
export * from "./client";
export { HyperliquidView } from "./HyperliquidView";
export * from "./hyperliquid-contracts";
export { interact } from "./hyperliquid-interact";
export { hyperliquidPlugin } from "./plugin";
export * from "./register";
export * from "./routes";
export * from "./useHyperliquidState";
