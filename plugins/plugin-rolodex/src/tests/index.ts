import { type TestSuite } from '@elizaos/core';
import { rolodexE2ETests } from './e2e.test';
import { rolodexScenarioTests } from './scenarios.test';
import { entityGraphTestSuite } from './entity-graph.test';

export const rolodexTests: TestSuite = {
  name: 'Rolodex Plugin Tests',
  tests: [...rolodexE2ETests.tests, ...rolodexScenarioTests.tests, ...entityGraphTestSuite.tests],
};

export const e2eTestSuite = rolodexE2ETests;
export { rolodexScenarioTests, entityGraphTestSuite };
