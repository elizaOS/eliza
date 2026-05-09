/**
 * Provider that injects plain text task-agent action examples into the prompt context.
 *
 * ElizaOS core only shows exampleCalls from its static action-docs registry,
 * which doesn't include custom plugin actions. This provider bridges the gap
 * by formatting our task-agent action examples in the same compact plain-text
 * style the model sees for core actions.
 *
 * @module providers/action-examples
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { getPtyService } from "../services/pty-service.js";
import {
  formatTaskAgentFrameworkLine,
  getTaskAgentFrameworkState,
  looksLikeTaskAgentRequest,
  TASK_AGENT_FRAMEWORK_LABELS,
} from "../services/task-agent-frameworks.js";

const MAX_FRAMEWORK_LINES = 12;
const MAX_FRAMEWORK_DATA = 12;

export const codingAgentExamplesProvider: Provider = {
  name: "CODING_AGENT_EXAMPLES",
  description:
    "Plain text examples showing how to use ACPX task-agent actions, framework availability, and subscription-aware defaults",
  descriptionCompressed:
    "ACPX task-agent action examples, framework availability, subscription defaults.",
  position: -1,
  contexts: ["code", "tasks", "agent_internal"],
  contextGate: { anyOf: ["code", "tasks", "agent_internal"] },
  cacheStable: true,
  cacheScope: "agent",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const userText =
        (typeof message.content === "string"
          ? message.content
          : message.content?.text) ?? "";
      const ptyService = getPtyService(runtime) ?? undefined;
      const frameworkState = await getTaskAgentFrameworkState(
        runtime,
        ptyService,
      );
      const frameworks = frameworkState.frameworks.slice(0, MAX_FRAMEWORK_DATA);
      const frameworkLines = frameworks
        .slice(0, MAX_FRAMEWORK_LINES)
        .map(formatTaskAgentFrameworkLine);

      const compactText = [
        "task_agent_action_examples:",
        "  useWhen: work is more complicated than a simple direct reply",
        "  execution: asynchronous open-ended workers",
        "  capabilities: code, debug, research, write, analyze, plan, document, automate",
        `  recommendedDefault: ${TASK_AGENT_FRAMEWORK_LABELS[frameworkState.preferred.id]}`,
        `  recommendedReason: ${frameworkState.preferred.reason}`,
        ...(frameworkState.configuredSubscriptionProvider
          ? [
              `  configuredSubscriptionProvider: ${frameworkState.configuredSubscriptionProvider}`,
            ]
          : []),
        `frameworks[${frameworkLines.length}]:`,
        ...frameworkLines,
        "canonicalActions:",
        "  create: CREATE_AGENT_TASK",
        "  directSpawn: SPAWN_AGENT",
        "  sendInput: SEND_TO_AGENT",
        "  status: provider.active_workspace_context",
        "  cancel: STOP_AGENT",
        "  history: TASK_HISTORY",
        "  control: TASK_CONTROL",
        "  share: TASK_SHARE",
        "  workspace: PROVISION_WORKSPACE or FINALIZE_WORKSPACE",
      ].join("\n");

      if (!looksLikeTaskAgentRequest(userText)) {
        return {
          data: {
            preferredTaskAgent: frameworkState.preferred.id,
            frameworks,
          },
          values: { taskAgentExamples: compactText },
          text: compactText,
        };
      }

      const detailedText = [
        compactText,
        "",
        "examples[5]{user,actions,params}:",
        "  Investigate why production login returns 401s in https://github.com/acme/app and fix it,REPLY|CREATE_AGENT_TASK,repo=https://github.com/acme/app; task=Investigate login 401s implement fix run tests summarize root cause",
        "  Research browser automation options compare them and draft a recommendation doc,REPLY|CREATE_AGENT_TASK,agents=Research Playwright tradeoffs | Compare Stagehand Playwright browser-use | Draft recommendation memo",
        "  Tell the running sub-agent to accept that prompt and continue,REPLY|SEND_TO_AGENT,input=Yes accept it and continue",
        "  What are you working on right now?,TASK_HISTORY,metric=list; window=active",
        "  Can I see it?,TASK_SHARE,none",
        "guidance:",
        "  preferCreateAgentTask: use ACPX CREATE_AGENT_TASK for open-ended multi-step async work",
        "  repoContext: include repo or workspace when user references real project or prior workspace",
        "  parallelism: use multiple agents only for separable subtasks",
        "  statusQuestions: use provider.active_workspace_context or TASK_HISTORY",
        "  controlRequests: use TASK_CONTROL",
        "  shareRequests: use TASK_SHARE",
      ].join("\n");

      return {
        data: {
          preferredTaskAgent: frameworkState.preferred.id,
          frameworks,
        },
        values: { taskAgentExamples: detailedText },
        text: detailedText,
      };
    } catch {
      return { text: "", values: {}, data: {} };
    }
  },
};

export const taskAgentExamplesProvider = codingAgentExamplesProvider;
