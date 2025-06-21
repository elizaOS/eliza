import { type Plugin } from '@elizaos/core';
import { walletServiceTestSuite } from './tests/wallet-service.test';
import { lpServiceTestSuite } from './tests/lp-service.test';
import { tokenDataServiceTestSuite } from './tests/token-data-service.test';
import { tokenCreationServiceTestSuite } from './tests/token-creation-service.test';
import { swapServiceTestSuite } from './tests/swap-service.test';
import { messagingServiceTestSuite } from './tests/messaging-service.test';
import { dummyServiceTestSuite } from './tests/dummy-services.test';

export const lowlevelTestingPlugin: Plugin = {
  name: 'lowlevel-testing',
  description: 'Tests real implementations of standardized ElizaOS service interfaces',
  testDependencies: ['@elizaos/plugin-dummy-services'],
  tests: [
    walletServiceTestSuite,
    lpServiceTestSuite,
    tokenDataServiceTestSuite,
    tokenCreationServiceTestSuite,
    swapServiceTestSuite,
    messagingServiceTestSuite,
    dummyServiceTestSuite,
  ],
  init: async (runtime) => {
    console.log('Low-level Testing Plugin Initialized');
    console.log('This plugin tests real service implementations with actual API keys');
    console.log('Make sure all required environment variables are set');
  },
};

export default lowlevelTestingPlugin;
