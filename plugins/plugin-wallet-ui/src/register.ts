/**
 * Side-effect entry point: registers the wallet shell page/widgets and, in a
 * DOM-less terminal host, the terminal inventory view. Also re-exports the
 * chain/address constants that consumers import from the package root, since
 * the app build aliases `@elizaos/plugin-wallet-ui` to this module rather than
 * the full barrel.
 */
import "./register-routes.ts";

export { getExplorerTokenUrl } from "./inventory/chainConfig.ts";
export {
  BSC_GAS_READY_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
} from "./inventory/constants.ts";

// In a terminal host (the Node agent, no DOM), register the wallet inventory
// view so it renders inline in the terminal. Lazy + DOM-guarded so the terminal
// engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerWalletTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
