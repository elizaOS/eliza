/**
 * Side-effect entry point that registers wallet shell routes/widgets and
 * re-exports chain/address constants used by consumers that alias the package
 * root to this app-register module.
 */
import "./ui/register-routes.ts";

export { getExplorerTokenUrl } from "./ui/inventory/chainConfig.ts";
export {
  BSC_GAS_READY_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
} from "./ui/inventory/constants.ts";
