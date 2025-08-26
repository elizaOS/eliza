import { IAgentRuntime } from '@elizaos/core';
import { TestCase, TestSuite } from '@elizaos/core';
import { logger } from '@elizaos/core';

export const dummyServicesScenariosSuite: TestSuite = {
  name: 'Dummy Services E2E Tests',
  tests: [
    {
      name: 'Dummy test placeholder',
      async fn(runtime: IAgentRuntime) {
        logger.info('Dummy services test placeholder');
        // Test cases don't return values, they just throw on failure
      },
    },
  ],
};
