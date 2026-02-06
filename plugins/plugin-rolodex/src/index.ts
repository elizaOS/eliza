import type { Plugin } from '@elizaos/core';
import { logger } from '@elizaos/core';

import * as actions from './actions/index.ts';
import * as evaluators from './evaluators/index.ts';
import * as providers from './providers/index.ts';
import { RolodexService, FollowUpService, EntityResolutionService } from './services/index.ts';
import { rolodexTests, e2eTestSuite, rolodexScenarioTests, entityGraphTestSuite } from './tests/index.ts';

export * from './actions/index.ts';
export * from './evaluators/index.ts';
export * from './providers/index.ts';
export * from './services/index.ts';
export * from './tests/index.ts';
export * from './types/index.ts';

export const rolodexPlugin: Plugin = {
  name: 'rolodex',
  description: 'Comprehensive contact, relationship, and cross-platform identity management',
  actions: [
    actions.sendMessageAction,
    actions.updateEntityAction,
    actions.addContactAction,
    actions.scheduleFollowUpAction,
    actions.searchContactsAction,
    actions.updateContactAction,
    actions.removeContactAction,
  ],
  evaluators: [evaluators.reflectionEvaluator, evaluators.relationshipExtractionEvaluator],
  providers: [
    providers.relationshipsProvider,
    providers.factsProvider,
    providers.contactsProvider,
    providers.followUpsProvider,
  ],
  services: [RolodexService, FollowUpService, EntityResolutionService],
  tests: [rolodexTests, e2eTestSuite, rolodexScenarioTests, entityGraphTestSuite],
  init: async ({ config, runtime }) => {
    logger.info('[Rolodex] Plugin initialized with LLM-based extraction and entity resolution');
  },
};

export default rolodexPlugin;

export { rolodexPlugin as testExports };
