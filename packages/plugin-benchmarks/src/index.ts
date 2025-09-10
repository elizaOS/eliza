import type { Plugin } from '@elizaos/core';
import { retailActions } from './actions/index';
import { actionBenchFrontendRoutes } from './routes/frontend';
import { testRoute, createChannelRoute } from './routes/test-operations';

export const typewriterPlugin: Plugin = {
  name: 'action-bench-typewriter',
  description:
    'Typewriter benchmark plugin providing 26 single-letter actions (A–Z) to test action selection and chaining.',
  actions: [...retailActions],
  routes: [...actionBenchFrontendRoutes, createChannelRoute, testRoute],
};

export default typewriterPlugin;
