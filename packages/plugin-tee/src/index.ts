import { type IAgentRuntime, type Plugin, type TeeVendorConfig, logger } from '@elizaos/core';
import { TeeVendorNames } from './vendors/types';
import { getVendor } from './vendors/index';
import { TEEService } from './service';

export type { TeeVendorConfig };

// Get the default Phala vendor
const defaultVendor = getVendor(TeeVendorNames.PHALA);

/**
 * TEE plugin for Trusted Execution Environment integration
 */
export const teePlugin: Plugin = {
  name: 'tee-plugin',
  description: 'Trusted Execution Environment (TEE) integration plugin',
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    const vendorName =
      config.TEE_VENDOR || runtime.getSetting('TEE_VENDOR') || TeeVendorNames.PHALA;
    logger.info(`Initializing TEE with vendor: ${vendorName}`);

    // Configure vendor-specific settings if needed
    // This is where you'd handle any vendor-specific initialization

    logger.info(`TEE initialized with vendor: ${vendorName}`);
  },
  actions: defaultVendor.getActions(),
  evaluators: [],
  providers: defaultVendor.getProviders(),
  services: [TEEService],
};

export default teePlugin;
