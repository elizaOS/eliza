/**
 * TEE Plugin for elizaOS
 *
 * Provides Trusted Execution Environment (TEE) integration for secure key
 * management and remote attestation.
 *
 * ## Features
 *
 * - **Remote Attestation**: Prove the agent is running in a TEE
 * - **Key Derivation**: Securely derive Ed25519 (Solana) and ECDSA (EVM) keys
 * - **Vendor Support**: Extensible vendor system (currently supports Phala Network)
 *
 * ## Configuration
 *
 * Required:
 * - TEE_MODE: LOCAL | DOCKER | PRODUCTION
 * - WALLET_SECRET_SALT: Secret for key derivation
 *
 * Optional:
 * - TEE_VENDOR: Vendor name (default: "phala")
 */

import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { TEEService } from "./services/tee";
import { getVendor, TeeVendorNames } from "./vendors";

// Export actions
export { remoteAttestationAction } from "./actions";

// Export providers
export {
  DeriveKeyProvider,
  PhalaDeriveKeyProvider,
  PhalaRemoteAttestationProvider,
  phalaDeriveKeyProvider,
  phalaRemoteAttestationProvider,
  RemoteAttestationProvider,
} from "./providers";
// Export services
export { TEEService } from "./services";
// Export all types
export * from "./types";
// Export utils
export {
  calculateSHA256,
  getTeeEndpoint,
  hexToUint8Array,
  sha256Bytes,
  uint8ArrayToHex,
  uploadAttestationQuote,
} from "./utils";
// Export vendors
export {
  getVendor,
  PhalaVendor,
  type TeeVendorInterface,
  TeeVendorNames,
} from "./vendors";

/**
 * Get the default vendor.
 */
const defaultVendor = getVendor(TeeVendorNames.PHALA);

/**
 * TEE plugin for Trusted Execution Environment integration.
 */
export const teePlugin: Plugin = {
  name: "tee",
  description:
    "Trusted Execution Environment (TEE) integration plugin for secure key management and remote attestation",

  config: {
    TEE_MODE: process.env.TEE_MODE,
    TEE_VENDOR: process.env.TEE_VENDOR,
    WALLET_SECRET_SALT: process.env.WALLET_SECRET_SALT,
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    const vendorName =
      config.TEE_VENDOR ?? runtime.getSetting("TEE_VENDOR") ?? TeeVendorNames.PHALA;
    const teeModeRaw = config.TEE_MODE ?? runtime.getSetting("TEE_MODE") ?? "LOCAL";
    const teeMode = typeof teeModeRaw === "string" ? teeModeRaw : String(teeModeRaw);

    logger.info(`Initializing TEE plugin with vendor: ${vendorName}, mode: ${teeMode}`);

    // Validate configuration
    if (!["LOCAL", "DOCKER", "PRODUCTION"].includes(teeMode.toUpperCase())) {
      throw new Error(`Invalid TEE_MODE: ${teeMode}. Must be one of: LOCAL, DOCKER, PRODUCTION`);
    }

    logger.info(`TEE plugin initialized successfully`);
  },

  actions: defaultVendor.getActions(),
  providers: defaultVendor.getProviders(),
  services: [TEEService],
  evaluators: [],
};

export default teePlugin;
