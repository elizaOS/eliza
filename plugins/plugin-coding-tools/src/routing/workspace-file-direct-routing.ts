import type { DirectActionRoutingRule } from "@elizaos/core";

const WORKSPACE_MUTATION =
  /\b(?:add|change|create|delete|edit|fix|make|move|read|remove|rename|replace|update|write)\b/i;
const WORKSPACE_NOUN =
  /\b(?:code|codebase|file|project|repo|repository|script|source)\b/i;
const LOCAL_FILE_REFERENCE =
  /(?:^|[\s("'`])(?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:bash|c|cc|cpp|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|php|py|rb|rs|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)(?=$|[\s,;:!?"'`)])/i;
const EXECUTION_REQUEST = /\b(?:execute|run|test|try|verify)\b/i;
const EXPLICIT_DELEGATION =
  /\b(?:ask\s+(?:a|the)\s+(?:coding\s+)?agent|coding\s+agent|delegate|spawn|sub[- ]?agent)\b/i;

export function matchesWorkspaceFileRequest(messageText: string): boolean {
  const text = messageText.trim();
  if (
    !text ||
    !WORKSPACE_MUTATION.test(text) ||
    EXPLICIT_DELEGATION.test(text)
  ) {
    return false;
  }
  return LOCAL_FILE_REFERENCE.test(text) || WORKSPACE_NOUN.test(text);
}

export function matchesWorkspaceFileExecutionRequest(
  messageText: string,
): boolean {
  return (
    matchesWorkspaceFileRequest(messageText) &&
    EXECUTION_REQUEST.test(messageText)
  );
}

export function createWorkspaceFileDirectRoutingRule(): DirectActionRoutingRule {
  return {
    id: "coding-tools.workspace-file",
    actionNames: ["FILE"],
    // Tool-aware models sometimes emit descriptive aliases instead of the
    // registered action name. Reconcile them only inside this deterministic
    // workspace-file intent boundary.
    replacesActionNames: [
      "FILES",
      "READ_FILE",
      "WRITE_FILE",
      "EDIT_FILE",
      "WRITE_CODE",
      "TASKS",
      "TASKS_CREATE",
    ],
    requiredActionTags: ["workspace-file"],
    contexts: ["code"],
    matches: matchesWorkspaceFileRequest,
  };
}

export function createWorkspaceFileExecutionDirectRoutingRule(): DirectActionRoutingRule {
  return {
    id: "coding-tools.workspace-file-execution",
    actionNames: ["FILE", "SHELL"],
    replacesActionNames: [
      "FILES",
      "READ_FILE",
      "WRITE_FILE",
      "EDIT_FILE",
      "WRITE_CODE",
      "RUN_CODE",
      "EXECUTE_COMMAND",
      "RUN_TERMINAL_COMMAND",
      "TASKS",
      "TASKS_CREATE",
    ],
    requiredActionTags: ["coding-tool"],
    contexts: ["code", "terminal"],
    matches: matchesWorkspaceFileExecutionRequest,
  };
}
