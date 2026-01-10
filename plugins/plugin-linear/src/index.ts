import { Plugin } from '@elizaos/core';
import { LinearService } from './services/linear';

// Import all actions
import { createIssueAction } from './actions/createIssue';
import { getIssueAction } from './actions/getIssue';
import { updateIssueAction } from './actions/updateIssue';
import { deleteIssueAction } from './actions/deleteIssue';
import { searchIssuesAction } from './actions/searchIssues';
import { createCommentAction } from './actions/createComment';
import { listTeamsAction } from './actions/listTeams';
import { listProjectsAction } from './actions/listProjects';
import { getActivityAction } from './actions/getActivity';
import { clearActivityAction } from './actions/clearActivity';

// Import all providers
// import { linearIssuesProvider } from './providers/issues';
// import { linearTeamsProvider } from './providers/teams';
// import { linearProjectsProvider } from './providers/projects';
// import { linearActivityProvider } from './providers/activity';

export const linearPlugin: Plugin = {
  name: '@elizaos/plugin-linear',
  description: 'Plugin for integrating with Linear issue tracking system',
  services: [LinearService],
  actions: [
    createIssueAction,
    getIssueAction,
    updateIssueAction,
    deleteIssueAction,
    searchIssuesAction,
    createCommentAction,
    listTeamsAction,
    listProjectsAction,
    getActivityAction,
    clearActivityAction,
  ],
  providers: [
    // linearIssuesProvider,
    // linearTeamsProvider,
    // linearProjectsProvider,
    // linearActivityProvider,
  ],
};

// Re-export types and service for external use
export * from './types';
export { LinearService } from './services/linear'; 