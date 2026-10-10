import { type Action, type ActionParameter, ElizaError } from "@elizaos/core";

// These are complete authored operation contracts, not a rendering filter.
// Keep the umbrella's parameters intact for legacy dispatch. Promotion adds
// the pinned discriminator and guards conflicting legacy aliases separately.
const sessionCreation = [
  "task",
  "agentType",
  "appMonetized",
  "requestedBackend",
  "taskComplexity",
  "workdir",
  "memoryContent",
  "label",
  "approvalPreset",
  "metadata",
  "validator",
  "maxRetries",
  "onVerificationFail",
] as const;

const operationParameters = {
  create: [
    ...sessionCreation,
    "agents",
    "dependencies",
    "maxParallel",
    "repo",
    "projectId",
    "title",
    "taskId",
    "threadId",
  ],
  spawn_agent: [...sessionCreation, "deferUserReply", "taskId", "threadId"],
  send: ["sessionId", "input", "keys", "task", "label", "metadata"],
  stop_agent: ["sessionId", "all"],
  list_agents: [],
  cancel: ["sessionId", "threadId", "all", "search", "reason"],
  history: [
    "sessionId",
    "metric",
    "window",
    "statuses",
    "limit",
    "includeArchived",
    "projectId",
    "search",
  ],
  control: [
    "controlAction",
    "agentType",
    "sessionId",
    "taskId",
    "threadId",
    "instruction",
    "note",
  ],
  share: ["sessionId", "threadId", "taskId", "search"],
  provision_workspace: [
    "repo",
    "baseBranch",
    "useWorktree",
    "parentWorkspaceId",
  ],
  submit_workspace: [
    "workspaceId",
    "baseBranch",
    "commitMessage",
    "prTitle",
    "prBody",
    "draft",
    "skipPR",
  ],
  manage_issues: [
    "issueAction",
    "repo",
    "title",
    "body",
    "issueNumber",
    "labels",
    "state",
  ],
  archive: ["taskId", "threadId"],
  reopen: ["taskId", "threadId"],
} as const;

export function taskOperationSchemaOverrides(parent: Action) {
  const byName = new Map(
    parent.parameters?.map((parameter) => [parameter.name, parameter]),
  );
  return Object.fromEntries(
    Object.entries(operationParameters).map(([operation, names]) => [
      operation,
      {
        parameters: names.map((name): ActionParameter => {
          const parameter = byName.get(name);
          if (!parameter)
            throw new ElizaError(
              `TASKS ${operation}: missing parameter ${name}`,
              {
                code: "TASKS_OPERATION_SCHEMA_INVALID",
                context: { operation, parameter: name },
              },
            );
          if (operation === "spawn_agent" && name === "task") {
            return { ...parameter, required: true };
          }
          if (operation === "create" && name === "title") {
            return { ...parameter, description: "Title of the coding task." };
          }
          return parameter;
        }),
      },
    ]),
  );
}
