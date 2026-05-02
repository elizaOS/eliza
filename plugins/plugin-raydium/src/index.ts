import { IAgentRuntime, Plugin } from '@elizaos/core';
import { RaydiumLpService } from './services/RaydiumLpService';
import { RaydiumSdkService } from './services/RaydiumSdkService';
import { positionProvider } from './providers/positionProvider';
import { raydiumScenariosSuite } from './e2e/scenarios';

const raydiumPlugin: Plugin = {
  name: '@elizaos/plugin-raydium',
  description: 'A plugin for interacting with the Raydium DEX using the V2 SDK.',
  services: [RaydiumSdkService, RaydiumLpService],
  providers: [positionProvider],
  tests: [raydiumScenariosSuite],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info('Raydium Plugin Initialized');
    // The RaydiumSdkService must be loaded with a wallet keypair before use.
    // This would typically happen in the agent's setup or initialization logic.
    // Example:
    // const sdkService = runtime.getService(RaydiumSdkService.serviceType) as RaydiumSdkService;
    // const owner = Keypair.fromSecretKey(...)
    // await sdkService.load(owner);
  },
};

export default raydiumPlugin;
