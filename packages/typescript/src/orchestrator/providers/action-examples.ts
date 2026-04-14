/**
 * Provider that injects structured task-agent action examples into the prompt context.
 *
 * ElizaOS core only shows exampleCalls from its static action-docs registry,
 * which doesn't include custom plugin actions. This provider bridges the gap
 * by formatting our task-agent action examples in the same structured format
 * the model sees for core actions.
 *
 * @module providers/action-examples
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { PTYService } from "../services/pty-service.ts";
import {
  formatTaskAgentFrameworkLine,
  getTaskAgentFrameworkState,
  looksLikeTaskAgentRequest,
  TASK_AGENT_FRAMEWORK_LABELS,
} from "../services/task-agent-frameworks.ts";

export const codingAgentExamplesProvider: Provider = {
  name: "CODING_AGENT_EXAMPLES",
  description:
    "Structured examples showing how to use open-ended task-agent actions, framework availability, and subscription-aware defaults",
  position: -1,

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const userText =
      (typeof message.content === "string"
        ? message.content
        : message.content?.text) ?? "";
    const ptyService = runtime.getService("PTY_SERVICE") as unknown as
      | PTYService
      | undefined;
    const frameworkState = await getTaskAgentFrameworkState(runtime, ptyService);
    const frameworkLines = frameworkState.frameworks.map(
      formatTaskAgentFrameworkLine,
    );

    const compactText = [
      "# Task Agent Action Call Examples",
      "Use task agents for anything more complicated than a simple direct reply.",
      "They are asynchronous, open-ended workers that can code, debug, research, write, analyze, plan, document, and automate while you stay free to keep talking with the user.",
      "",
      `Recommended default right now: ${TASK_AGENT_FRAMEWORK_LABELS[frameworkState.preferred.id]} (${frameworkState.preferred.reason}).`,
      ...(frameworkState.configuredSubscriptionProvider
        ? [
            `Configured Eliza subscription provider: ${frameworkState.configuredSubscriptionProvider}. Prefer the matching user-backed CLI first so Eliza does not waste cloud chat capacity.`,
          ]
        : []),
      "",
      "Current task-agent frameworks:",
      ...frameworkLines,
      "",
      "Canonical actions:",
      "- CREATE_TASK: launch one or more background task agents, optionally against a repo or workspace.",
      "- SPAWN_AGENT: start a specific task agent in an existing workspace when you need direct control.",
      "- SEND_TO_AGENT: reply to a running agent or send keys to unblock it.",
      "- LIST_AGENTS: inspect active task agents and current task status.",
      "- STOP_AGENT: cancel a running task agent.",
      "- TASK_HISTORY: answer questions like what is running now, what happened yesterday, or what changed last week without loading raw history into context.",
      "- TASK_CONTROL: pause, stop, resume, continue, archive, or reopen a tracked task thread.",
      "- TASK_SHARE: find the best artifact, preview URL, or workspace path when the user asks to see the result.",
      "- PROVISION_WORKSPACE / FINALIZE_WORKSPACE: manage workspaces before or after agent work when needed.",
    ].join("\n");

    if (!looksLikeTaskAgentRequest(userText)) {
      return {
        data: {
          preferredTaskAgent: frameworkState.preferred.id,
          frameworks: frameworkState.frameworks,
        },
        values: { taskAgentExamples: compactText },
        text: compactText,
      };
    }

    const detailedText = [
      compactText,
      "",
      "Examples:",
      'User: "Investigate why the production login flow started returning 401s in https://github.com/acme/app and fix it."',
      "Assistant:",
      "<actions>",
      "  <action>REPLY</action>",
      "  <action>CREATE_TASK</action>",
      "</actions>",
      "<params>",
      "  <CREATE_TASK>",
      "    <repo>https://github.com/acme/app</repo>",
      "    <task>Investigate the production login 401s, implement the fix, run the relevant tests, and summarize the root cause.</task>",
      "  </CREATE_TASK>",
      "</params>",
      "",
      'User: "Spin up a few sub-agents to research the current browser automation options, compare them, and draft a recommendation doc."',
      "Assistant:",
      "<actions>",
      "  <action>REPLY</action>",
      "  <action>CREATE_TASK</action>",
      "</actions>",
      "<params>",
      "  <CREATE_TASK>",
      '    <agents>Research Playwright tradeoffs and browser sandboxing. Your identifier is "research". | Compare Stagehand, Playwright, and browser-use for Eliza. Your identifier is "comparison". | Draft a recommendation memo in TASK_AGENTS.md using the findings. Your identifier is "writer".</agents>',
      "  </CREATE_TASK>",
      "</params>",
      "",
      'User: "Tell the running sub-agent to accept that prompt and continue."',
      "Assistant:",
      "<actions>",
      "  <action>REPLY</action>",
      "  <action>SEND_TO_AGENT</action>",
      "</actions>",
      "<params>",
      "  <SEND_TO_AGENT>",
      "    <input>Yes, accept it and continue.</input>",
      "  </SEND_TO_AGENT>",
      "</params>",
      "",
      'User: "What are you working on right now?"',
      "Assistant:",
      "<actions>",
      "  <action>TASK_HISTORY</action>",
      "</actions>",
      "<params>",
      "  <TASK_HISTORY>",
      "    <metric>list</metric>",
      "    <window>active</window>",
      "  </TASK_HISTORY>",
      "</params>",
      "",
      "User: \"Hold on a second, can you pause that and let's discuss if it's right?\"",
      "Assistant:",
      "<actions>",
      "  <action>REPLY</action>",
      "  <action>TASK_CONTROL</action>",
      "</actions>",
      "<params>",
      "  <TASK_CONTROL>",
      "    <operation>pause</operation>",
      "  </TASK_CONTROL>",
      "</params>",
      "",
      'User: "Can I see it?"',
      "Assistant:",
      "<actions>",
      "  <action>TASK_SHARE</action>",
      "</actions>",
      "<params>",
      "  <TASK_SHARE />",
      "</params>",
      "",
      "Guidance:",
      "- Prefer CREATE_TASK whenever the work is open-ended, multi-step, or can continue asynchronously.",
      "- If the task references a real repository or prior workspace, include the repo or workspace context instead of dropping the agent into scratch space.",
      "- Use multiple agents only when the subtasks are clearly separable and benefit from parallelism.",
      "- Use TASK_HISTORY instead of free-form guessing when the user asks about current work, counts, yesterday, last week, or topic-scoped history.",
      "- Use TASK_CONTROL when the user wants to pause, stop, resume, continue, archive, or reopen a task thread.",
      "- Use TASK_SHARE when the user asks to see the output, pull it up, or view it remotely.",
    ].join("\n");

    return {
      data: {
        preferredTaskAgent: frameworkState.preferred.id,
        frameworks: frameworkState.frameworks,
      },
      values: { taskAgentExamples: detailedText },
      text: detailedText,
    };
  },
};

export const taskAgentExamplesProvider = codingAgentExamplesProvider;
