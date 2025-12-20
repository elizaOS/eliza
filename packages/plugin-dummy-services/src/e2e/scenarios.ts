import { IAgentRuntime } from '@elizaos/core';
import { TestSuite } from '@elizaos/core';
import { logger } from '@elizaos/core';

export const dummyServicesScenariosSuite: TestSuite = {
  name: 'Dummy Services E2E Tests',
  tests: [
    {
      name: 'Dummy test placeholder',
      async fn(_runtime: IAgentRuntime) {
        logger.info({ src: 'plugin:dummy-services:e2e' }, 'Dummy services test placeholder');
        // Test cases don't return values, they just throw on failure
      },
    },
  ],
};
