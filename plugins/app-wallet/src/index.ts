// Re-exports for hosts that import directly from "@elizaos/app-wallet".

export { InventoryView } from "./InventoryView.tsx";
export { ChainIcon } from "./inventory/ChainIcon.tsx";
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
} from "./inventory/chainConfig.ts";
export {
  BSC_GAS_READY_THRESHOLD,
  BSC_GAS_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
  type NftItem,
  type TokenRow,
  toNormalizedAddress,
} from "./inventory/constants.ts";
export { TokenLogo } from "./inventory/TokenLogo.tsx";
export { useInventoryData } from "./inventory/useInventoryData.ts";
export { walletAppPlugin } from "./plugin.ts";
export { useWalletState } from "./state/useWalletState.ts";
export {
  buildWalletRpcUpdateRequest,
  resolveInitialWalletRpcSelections,
} from "./wallet-rpc.ts";
export {
  WALLET_STATUS_WIDGET,
  WalletStatusSidebarWidget,
} from "./widgets/wallet-status.tsx";
export * from "./ui.ts";
export * from "./register.ts";
