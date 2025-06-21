import { type Plugin } from '@elizaos/core';

import * as actions from './actions/index.ts';
import * as providers from './providers/index.ts';

import { TaskService } from './services/task.ts';

export const tasksPlugin: Plugin = {
  name: 'tasks',
  description: 'Agent tasks with basic actions and evaluators',
  actions: [actions.choiceAction],
  providers: [providers.choiceProvider],
  services: [TaskService],
};

export default tasksPlugin;
