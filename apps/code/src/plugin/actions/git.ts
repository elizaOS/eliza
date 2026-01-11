import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { createGitError, formatErrorForDisplay } from "../../lib/errors.js";
import { getCwd } from "../providers/cwd.js";

const execAsync = promisify(exec);

type GitOperation =
  | "status"
  | "diff"
  | "log"
  | "branch"
  | "commit"
  | "add"
  | "push"
  | "pull"
  | "checkout"
  | "other";

function extractGitOperation(text: string): GitOperation {
  const lower = text.toLowerCase();
  if (lower.includes("status")) return "status";
  if (lower.includes("diff")) return "diff";
  if (lower.includes("log") || lower.includes("history")) return "log";
  if (lower.includes("branch")) return "branch";
  if (lower.includes("commit")) return "commit";
  if (lower.includes("add") || lower.includes("stage")) return "add";
  if (lower.includes("push")) return "push";
  if (lower.includes("pull")) return "pull";
  if (lower.includes("checkout") || lower.includes("switch")) return "checkout";
  return "other";
}

function extractGitCommand(text: string, operation: GitOperation): string {
  const explicitMatch = text.match(/git\s+(.+?)(?:\.|$)/i);
  if (explicitMatch) return `git ${explicitMatch[1].trim()}`;

  switch (operation) {
    case "status":
      return "git status";
    case "diff":
      return "git diff";
    case "log":
      return "git log --oneline -20";
    case "branch":
      return "git branch -a";
    case "commit": {
      const msgMatch =
        text.match(/(?:message|msg)[:\s]+["'](.+?)["']/i) ||
        text.match(/commit\s+["'](.+?)["']/i);
      return msgMatch ? `git commit -m "${msgMatch[1]}"` : "git status";
    }
    case "add": {
      const filesMatch = text.match(/(?:add|stage)\s+(.+?)(?:\.|$)/i);
      return filesMatch ? `git add ${filesMatch[1].trim()}` : "git add -A";
    }
    case "push":
      return "git push";
    case "pull":
      return "git pull";
    case "checkout": {
      const branchMatch = text.match(/(?:checkout|switch)\s+(?:to\s+)?(\S+)/i);
      return branchMatch ? `git checkout ${branchMatch[1]}` : "git branch";
    }
    default:
      return "git status";
  }
}

export const gitAction: Action = {
  name: "GIT",
  similes: [
    "GIT_STATUS",
    "GIT_DIFF",
    "GIT_LOG",
    "GIT_COMMIT",
    "VERSION_CONTROL",
  ],
  description: `Execute git commands for version control operations with intelligent command parsing.

USE THIS ACTION WHEN:
- User mentions "git" or specific git operations
- User wants to check status, view diff, see history, or manage branches
- User wants to commit, push, pull, or checkout
- User asks about changes, commits, or branch state

DO NOT USE WHEN:
- User wants to run non-git shell commands (use EXECUTE_SHELL)
- User wants to read file contents (use READ_FILE)
- User wants to modify files (use EDIT_FILE or WRITE_FILE)

SUPPORTED OPERATIONS:
- status: Show working tree status
- diff: Show changes between commits, working tree, etc.
- log: Show commit history (default: last 20 commits)
- branch: List, create, or manage branches
- commit: Create a commit (extracts message from request)
- add: Stage files for commit
- push/pull: Sync with remote repository
- checkout: Switch branches or restore files

INTELLIGENT PARSING:
- "show git status" → git status
- "what changed" → git diff
- "commit with message 'Fix bug'" → git commit -m "Fix bug"
- "switch to main" → git checkout main`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("git") ||
      text.includes("commit") ||
      text.includes("push") ||
      text.includes("pull") ||
      text.includes("branch") ||
      text.includes("diff") ||
      text.includes("status")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content.text ?? "";
    const operation = extractGitOperation(text);
    const command = extractGitCommand(text, operation);
    const cwd = getCwd();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 30000,
      });

      let output = `$ ${command}\n`;
      if (stdout) output += stdout;
      if (stderr && !stderr.includes("warning"))
        output += `\nstderr:\n${stderr}`;

      const truncated =
        output.length > 3000
          ? `${output.substring(0, 3000)}\n...(truncated)`
          : output;
      const result = `\`\`\`\n${truncated}\n\`\`\``;

      await callback?.({ text: result });
      return { success: true, text: result, data: { command, operation } };
    } catch (err) {
      const error = err as Error & { code?: number; stderr?: string };
      const gitError = createGitError(
        command,
        error.code ?? 1,
        error.stderr ?? error.message,
      );
      const errorMsg = formatErrorForDisplay(gitError);

      logger.error(`GIT error: ${error.message}`);
      await callback?.({ text: errorMsg });
      return { success: false, text: errorMsg };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "show git status" } },
      {
        name: "{{agent}}",
        content: { text: "Checking git status...", actions: ["GIT"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "commit with message 'Fix bug'" } },
      {
        name: "{{agent}}",
        content: { text: "Creating commit...", actions: ["GIT"] },
      },
    ],
  ],
};
