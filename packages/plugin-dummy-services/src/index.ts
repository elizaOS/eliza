import { type Plugin } from '@elizaos/core';
import { DummyTokenDataService } from './tokenData/service';
import { DummyLpService } from './lp/service';
import { DummyWalletService } from './wallet/service';
import { dummyServicesScenariosSuite } from './e2e/scenarios';

export const dummyServicesPlugin: Plugin = {
  name: 'dummy-services',
  description: 'Load standard dummy services for testing purposes.',
  services: [DummyTokenDataService, DummyLpService, DummyWalletService],
  tests: [dummyServicesScenariosSuite],
  init: async (runtime) => {
    console.log('Dummy Services Plugin Initialized');
  },
};

export default dummyServicesPlugin;

// Export services for direct use
export { DummyTokenDataService, DummyLpService, DummyWalletService };
