/**
 * Side-effect entry point: registers the wallet shell page/widgets. Also
 * re-exports the chain/address constants that consumers import from the package
 * root, since the app build aliases `@elizaos/plugin-wallet-ui` to this module
 * rather than the full barrel.
 */
import "./register-routes.ts";

export { getExplorerTokenUrl } from "./inventory/chainConfig.ts";
export {
  BSC_GAS_READY_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
} from "./inventory/constants.ts";
