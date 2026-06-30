import "./register-routes.ts";

// Re-export the chain/address constants consumers import from the package root.
// The app build aliases `@elizaos/plugin-wallet-ui` to THIS module (side-effect
// entry, not the full barrel), so wallet-consuming plugins
// (`import { isBscChainName } from "@elizaos/plugin-wallet-ui"`) resolve here.
export {
  BSC_GAS_READY_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
} from "./inventory/constants.ts";
export { getExplorerTokenUrl } from "./inventory/chainConfig.ts";

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
