/**
 * Valhalla Mech copy-trading plugin.
 * Live swaps are off unless VALHALLA_LIVE_TRADING=true.
 * The package has no transfer, withdraw, or sweep action.
 */
export { evaluateCoinAction, pnlAction, tradingControlAction } from "./actions.ts";
export { evaluateCoin, type CoinSnapshot, type Evaluation } from "./evaluate.ts";
export { decideExit } from "./exits.ts";
export { generateWithGemini } from "./gemini.ts";
export { LIMITS } from "./limits.ts";
export { liveTradingEnabled, loadWalletSecret } from "./safety-gate.ts";
export { chooseSize } from "./sizing.ts";
export { valhallaCopybotPlugin, valhallaCopybotPlugin as default } from "./plugin.ts";
export { getValhallaService, ValhallaTradingService } from "./service.ts";
export { isForbiddenActionName } from "./swap-guard.ts";
