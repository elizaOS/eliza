import type { Plugin } from "@elizaos/core";
import { clearActivityAction } from "./actions/clearActivity";
import { createCommentAction } from "./actions/createComment";
// Import all actions
import { createIssueAction } from "./actions/createIssue";
import { deleteIssueAction } from "./actions/deleteIssue";
import { getActivityAction } from "./actions/getActivity";
import { getIssueAction } from "./actions/getIssue";
import { listProjectsAction } from "./actions/listProjects";
import { listTeamsAction } from "./actions/listTeams";
import { searchIssuesAction } from "./actions/searchIssues";
import { updateIssueAction } from "./actions/updateIssue";
import { linearActivityProvider } from "./providers/activity";

// Import all providers
import { linearIssuesProvider } from "./providers/issues";
import { linearProjectsProvider } from "./providers/projects";
import { linearTeamsProvider } from "./providers/teams";
import { LinearService } from "./services/linear";

export const linearPlugin: Plugin = {
  name: "@elizaos/plugin-linear-ts",
  description: "Plugin for integrating with Linear issue tracking system",
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
    linearIssuesProvider,
    linearTeamsProvider,
    linearProjectsProvider,
    linearActivityProvider,
  ],
};

export { LinearService } from "./services/linear";
// Re-export types and service for external use
export * from "./types";
