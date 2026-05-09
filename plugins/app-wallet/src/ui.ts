import "./register-routes";

export { InventoryView } from "./InventoryView";
export { ChainIcon } from "./inventory/ChainIcon";
export { TokenLogo } from "./inventory/TokenLogo";
export {
  CHAIN_CONFIGS,
  type ChainConfig,
  type ChainKey,
  chainKeyToWalletRpcChain,
  getChainConfig,
  getContractLogoUrl,
  getExplorerTokenUrl,
  getExplorerTxUrl,
  getNativeLogoUrl,
  getStablecoinAddress,
  PRIMARY_CHAIN_KEYS,
  resolveChainKey,
} from "./inventory/chainConfig";
export {
  BSC_GAS_READY_THRESHOLD,
  BSC_GAS_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
  type NftItem,
  type TokenRow,
  toNormalizedAddress,
} from "./inventory/constants";
export { useInventoryData } from "./inventory/useInventoryData";
export { useWalletState } from "./state/useWalletState";
export {
  buildWalletRpcUpdateRequest,
  resolveInitialWalletRpcSelections,
} from "./wallet-rpc";
export {
  WalletStatusSidebarWidget,
  WALLET_STATUS_WIDGET,
} from "./widgets/wallet-status";
