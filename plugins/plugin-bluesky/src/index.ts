import { BlueSkyService } from './service.js';
import { BlueSkyTestSuite } from './__tests__/e2e/suite.js';

const testSuite = new BlueSkyTestSuite();

const blueSkyPlugin = {
  name: 'bluesky',
  description: 'BlueSky client plugin using AT Protocol',
  services: [BlueSkyService],
  tests: [
    {
      name: testSuite.name,
      description: testSuite.description,
      tests: testSuite.tests
    }
  ],
};

export default blueSkyPlugin;

// Export for testing
export { BlueSkyClient } from './client.js';
export { BlueSkyService } from './service.js';
export { validateBlueSkyConfig } from './common/config.js';
