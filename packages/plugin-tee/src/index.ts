import {
    type IAgentRuntime,
    logger,
    type Plugin,
    type TeePluginConfig,
    type TeeVendorConfig,
} from '@elizaos/core';
import { TeeLogService } from './services/teeLogService';
import { getVendor, TeeVendorNames } from './vendors';

export { PhalaDeriveKeyProvider } from './providers/deriveKeyProvider';
export { PhalaRemoteAttestationProvider } from './providers/remoteAttestationProvider';
export { TeeLogService };
export type { TeeVendorConfig };

async function initializeTEE(config: Record<string, string>, runtime: IAgentRuntime) {
    if (config.TEE_VENDOR || runtime.getSetting('TEE_VENDOR')) {
        const vendor = config.TEE_VENDOR || runtime.getSetting('TEE_VENDOR');
        logger.info(`Initializing TEE with vendor: ${vendor}`);
        let plugin: Plugin;
        switch (vendor) {
            case 'phala':
                plugin = teePlugin({
                    vendor: TeeVendorNames.PHALA,
                    vendorConfig: {
                        apiKey: runtime.getSetting('TEE_API_KEY'),
                    },
                });
                break;
            case 'marlin':
                plugin = teePlugin({
                    vendor: TeeVendorNames.MARLIN,
                });
                break;
            case 'fleek':
                plugin = teePlugin({
                    vendor: TeeVendorNames.FLEEK,
                });
                break;
            case 'sgx-gramine':
                plugin = teePlugin({
                    vendor: TeeVendorNames.SGX_GRAMINE,
                });
                break;
            default:
                throw new Error(`Invalid TEE vendor: ${vendor}`);
        }
        logger.info(`Pushing plugin: ${plugin.name}`);
        runtime.plugins.push(plugin);
    }
}

export const teePlugin = (config?: TeePluginConfig): Plugin => {
    const vendorType = config?.vendor || TeeVendorNames.PHALA;
    const vendor = getVendor(vendorType);
    config = {
        ...config,
        vendor: vendorType,
    };
    return {
        name: vendor.getName(),
        init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
            return await initializeTEE(config, runtime);
        },
        description: vendor.getDescription(),
        actions: vendor.getActions(),
        evaluators: [],
        providers: vendor.getProviders(),
        services: [new TeeLogService()],
    };
};
