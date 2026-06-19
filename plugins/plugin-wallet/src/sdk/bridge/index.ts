/**
 * @module bridge
 * Re-exports for the bridge module: EVM↔EVM CCTP V2 bridge and EVM↔Solana bridge.
 *
 * Import from 'agentwallet-sdk/bridge' or 'agentwallet-sdk' (re-exported from root).
 *
 * EVM↔EVM: use BridgeModule or createBridge()
 * EVM↔Solana: use bridgeEVMToSolana() and receiveFromSolanaOnEVM()
 */

export {
  ERC20BridgeAbi,
  MessageTransmitterV2Abi,
  TokenMessengerV2Abi,
} from "./abis.js";
export {
  BRIDGE_CHAIN_IDS,
  BridgeError,
  BridgeModule,
  CCTP_DOMAIN_IDS,
  createBridge,
  FINALITY_THRESHOLD,
  MESSAGE_TRANSMITTER_V2,
  TOKEN_MESSENGER_V2,
  USDC_CONTRACT,
} from "./client.js";
export type {
  EVMToSolanaOptions,
  EVMToSolanaResult,
  SolanaBridgeErrorCode,
  SolanaToEVMBurnParams,
  SolanaToEVMOptions,
  SolanaToEVMResult,
} from "./solana.js";

// ─── Solana Bridge (optional — requires @solana/web3.js for full Solana-side execution) ───
export {
  bridgeEVMToSolana,
  bytes32ToSolanaPubkey,
  receiveFromSolanaOnEVM,
  SOLANA_CCTP_DOMAIN,
  SOLANA_DEFAULT_RPC,
  SOLANA_MESSAGE_TRANSMITTER,
  SOLANA_TOKEN_MESSENGER,
  SOLANA_USDC_MINT,
  SolanaBridgeError,
} from "./solana.js";
export type {
  AttestationResponse,
  AttestationStatus,
  BridgeChain,
  BridgeOptions,
  BridgeResult,
  BurnResult,
  EVMBridgeChain,
} from "./types.js";
