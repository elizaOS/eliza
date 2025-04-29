import {
  type IAgentRuntime,
  type Plugin,
  type TeePluginConfig,
  type TeeVendorConfig,
  logger,
} from '@elizaos/core';
import { TeeVendorNames } from './vendors/types';
import { getVendor } from './vendors/index';

export { phalaRemoteAttestationAction } from './actions/remoteAttestationAction';
export { PhalaDeriveKeyProvider } from './providers/deriveKeyProvider';
export { PhalaRemoteAttestationProvider } from './providers/remoteAttestationProvider';
export type { TeeVendorConfig };

/**
 * Asynchronously initializes the Trusted Execution Environment (TEE) based on the provided configuration and runtime settings.
 * @param {Record<string, string>} config - The configuration object containing TEE vendor information.
 * @param {IAgentRuntime} runtime - The runtime object with TEE related settings.
 * @returns {Promise<void>} - A promise that resolves once the TEE is initialized.
 */
async function initializeTEE(config: Record<string, string>, runtime: IAgentRuntime) {
  if (config.TEE_VENDOR || runtime.getSetting('TEE_VENDOR')) {
    const vendor = config.TEE_VENDOR || runtime.getSetting('TEE_VENDOR');
    logger.info(`Initializing TEE with vendor: ${vendor}`);
    let plugin: Plugin;
    switch (vendor) {
      case 'phala':
        plugin = teePlugin({
          vendor: TeeVendorNames.PHALA,
        });
        break;
      default:
        throw new Error(`Invalid TEE vendor: ${vendor}`);
    }
    logger.info(`Pushing plugin: ${plugin.name}`);
    runtime.plugins.push(plugin);
  }
}

/**
 * A function that creates a TEE (Trusted Execution Environment) plugin based on the provided configuration.
 * @param { TeePluginConfig } [config] - Optional configuration for the TEE plugin.
 * @returns { Plugin } - The TEE plugin containing initialization, description, actions, evaluators, providers, and services.
 */
export const teePlugin = (config?: TeePluginConfig): Plugin => {
  const vendorType = config?.vendor || TeeVendorNames.PHALA;
  const vendor = getVendor(vendorType);
  return {
    name: vendor.getName(),
    init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
      return await initializeTEE(
        {
          ...config,
          vendor: vendorType,
        },
        runtime
      );
    },
    description: vendor.getDescription(),
    actions: vendor.getActions(),
    evaluators: [],
    providers: vendor.getProviders(),
    services: [],
  };
};
