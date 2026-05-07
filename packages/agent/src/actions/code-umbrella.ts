/**
 * CODE umbrella action.
 *
 * Parent action for code/workspace/coding-task surfaces. Dispatches to the
 * appropriate child via the runtime sub-planner:
 *
 *   - CREATE_WORKSPACE        (provision a git workspace)
 *   - SUBMIT_WORKSPACE        (commit + push + optional PR)
 *   - ARCHIVE_CODING_TASK     (hide a coding-agent thread)
 *   - REOPEN_CODING_TASK      (return an archived thread to active list)
 *   - CLAUDE_CODE_WORKBENCH_LIST  (list allowlisted workbench workflows)
 *   - CLAUDE_CODE_WORKBENCH_RUN   (execute an allowlisted workbench workflow)
 *
 * Children are referenced by name; they remain registered as standalone
 * actions in their owning plugins. The sub-planner enumerates only this
 * umbrella's children when CODE is invoked.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

const CODE_SUB_ACTIONS = [
  "CREATE_WORKSPACE",
  "SUBMIT_WORKSPACE",
  "ARCHIVE_CODING_TASK",
  "REOPEN_CODING_TASK",
  "CLAUDE_CODE_WORKBENCH_LIST",
  "CLAUDE_CODE_WORKBENCH_RUN",
] as const;

export const codeAction: Action = {
  name: "CODE",
  contexts: ["code", "files", "tasks", "automation", "agent_internal"],
  contextGate: {
    anyOf: ["code", "files", "tasks", "automation", "agent_internal"],
  },
  roleGate: { minRole: "USER" },
  similes: ["CODING", "WORKSPACE", "CODE_TASK"],
  description:
    "Parent action for coding workspaces, coding-agent task threads, and Claude Code workbench workflows. " +
    "Dispatches to CREATE_WORKSPACE, SUBMIT_WORKSPACE, ARCHIVE_CODING_TASK, REOPEN_CODING_TASK, " +
    "CLAUDE_CODE_WORKBENCH_LIST, or CLAUDE_CODE_WORKBENCH_RUN.",
  descriptionCompressed:
    "code umbrella: workspace(create+submit) coding-task(archive+reopen) workbench(list+run)",
  suppressPostActionContinuation: true,
  subActions: [...CODE_SUB_ACTIONS],
  subPlanner: {
    name: "code_subplanner",
    description:
      "Explodes CREATE_WORKSPACE, SUBMIT_WORKSPACE, ARCHIVE_CODING_TASK, REOPEN_CODING_TASK, " +
      "CLAUDE_CODE_WORKBENCH_LIST, and CLAUDE_CODE_WORKBENCH_RUN so the planner can chain " +
      "multi-step coding-task and workspace operations.",
  },
  parameters: [],

  validate: async (): Promise<boolean> => true,

  // Handler runs only if sub-planner dispatch is bypassed (e.g. caller invokes
  // CODE without picking a child). It returns a structured no-op so the
  // planner sees the available child surface.
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text =
      "Pick a specific code sub-action: CREATE_WORKSPACE, SUBMIT_WORKSPACE, " +
      "ARCHIVE_CODING_TASK, REOPEN_CODING_TASK, CLAUDE_CODE_WORKBENCH_LIST, " +
      "or CLAUDE_CODE_WORKBENCH_RUN.";
    await callback?.({ text });
    return {
      text,
      success: false,
      values: { error: "use_sub_action" },
      data: { actionName: "CODE", subActions: [...CODE_SUB_ACTIONS] },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Set up a workspace for this fix and open a PR." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create a workspace, then submit it as a PR when done.",
          actions: ["CODE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Archive the old coding task abc-123." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Archiving coding task abc-123.",
          actions: ["CODE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Run the workbench check workflow." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Running workbench workflow `check`.",
          actions: ["CODE"],
        },
      },
    ],
  ],
};
