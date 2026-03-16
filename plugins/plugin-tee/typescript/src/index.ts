import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { TEEService } from "./services/tee";
import { getVendor, TeeVendorNames } from "./vendors";

export { remoteAttestationAction } from "./actions";
export {
  DeriveKeyProvider,
  PhalaDeriveKeyProvider,
  PhalaRemoteAttestationProvider,
  phalaDeriveKeyProvider,
  phalaRemoteAttestationProvider,
  RemoteAttestationProvider,
} from "./providers";
export { TEEService } from "./services";
export * from "./types";
export {
  calculateSHA256,
  getTeeEndpoint,
  hexToUint8Array,
  sha256Bytes,
  uint8ArrayToHex,
  uploadAttestationQuote,
} from "./utils";
export {
  getVendor,
  PhalaVendor,
  type TeeVendorInterface,
  TeeVendorNames,
} from "./vendors";

const defaultVendor = getVendor(TeeVendorNames.PHALA);

export const teePlugin: Plugin = {
  name: "tee",
  description: "TEE integration plugin for secure key management and remote attestation",

  config: {
    TEE_MODE: process.env.TEE_MODE ?? null,
    TEE_VENDOR: process.env.TEE_VENDOR ?? null,
    WALLET_SECRET_SALT: process.env.WALLET_SECRET_SALT ?? null,
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    const vendorName =
      config.TEE_VENDOR ?? runtime.getSetting("TEE_VENDOR") ?? TeeVendorNames.PHALA;
    const teeModeRaw = config.TEE_MODE ?? runtime.getSetting("TEE_MODE") ?? "LOCAL";
    const teeMode = typeof teeModeRaw === "string" ? teeModeRaw : String(teeModeRaw);

    logger.info(`Initializing TEE plugin with vendor: ${vendorName}, mode: ${teeMode}`);

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
