import type { Action, IAgentRuntime, Plugin } from "@elizaos/core";
import { clearActivityAction } from "./actions/clearActivity";
import { createCommentAction } from "./actions/createComment";
import { createIssueAction } from "./actions/createIssue";
import { deleteIssueAction } from "./actions/deleteIssue";
import { getActivityAction } from "./actions/getActivity";
import { getIssueAction } from "./actions/getIssue";
import {
  LINEAR_COMMENT_CONTEXT,
  LINEAR_ISSUE_CONTEXT,
  LINEAR_WORKFLOW_CONTEXT,
  linearCommentRouterAction,
  linearIssueRouterAction,
  linearWorkflowRouterAction,
} from "./actions/routers";
import { searchIssuesAction } from "./actions/searchIssues";
import { updateIssueAction } from "./actions/updateIssue";
import { linearActivityProvider } from "./providers/activity";
import { linearIssuesProvider } from "./providers/issues";
import { linearProjectsProvider } from "./providers/projects";
import { linearTeamsProvider } from "./providers/teams";
import { registerLinearSearchCategory } from "./search-category";
import { LinearService } from "./services/linear";

function withContexts(action: Action, contexts: string[]): Action {
  return {
    ...action,
    contexts: [...new Set([...(action.contexts ?? []), ...contexts])],
  };
}

const linearIssueActions = [
  createIssueAction,
  getIssueAction,
  updateIssueAction,
  deleteIssueAction,
].map((action) =>
  withContexts(action, ["general", "automation", "knowledge", LINEAR_ISSUE_CONTEXT])
);

const linearCommentActions = [createCommentAction].map((action) =>
  withContexts(action, ["general", "automation", LINEAR_COMMENT_CONTEXT])
);

const linearWorkflowActions = [getActivityAction, clearActivityAction, searchIssuesAction].map(
  (action) => withContexts(action, ["general", "automation", "knowledge", LINEAR_WORKFLOW_CONTEXT])
);

export const linearPlugin: Plugin = {
  name: "@elizaos/plugin-linear-ts",
  description: "Plugin for integrating with Linear issue tracking system",
  services: [LinearService],
  actions: [
    linearIssueRouterAction,
    linearCommentRouterAction,
    linearWorkflowRouterAction,
    ...linearIssueActions,
    ...linearCommentActions,
    ...linearWorkflowActions,
  ],
  providers: [
    linearIssuesProvider,
    linearTeamsProvider,
    linearProjectsProvider,
    linearActivityProvider,
  ],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    registerLinearSearchCategory(runtime);
  },
};

export { LinearService } from "./services/linear";
