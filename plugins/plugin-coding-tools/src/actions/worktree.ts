import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import { failureToActionResult, readStringParam } from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";
import { enterWorktreeHandler } from "./enter-worktree.js";
import { exitWorktreeHandler } from "./exit-worktree.js";

const WORKTREE_OPERATIONS = ["enter", "exit"] as const;
type WorktreeOperation = (typeof WORKTREE_OPERATIONS)[number];

type WorktreeHandler = (
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined,
) => Promise<ActionResult>;

const WORKTREE_ACTIONS: Record<WorktreeOperation, WorktreeHandler> = {
  enter: enterWorktreeHandler,
  exit: exitWorktreeHandler,
};

const WORKTREE_OPERATION_ALIASES: Record<string, WorktreeOperation> = {
  add: "enter",
  open: "enter",
  create: "enter",
  leave: "exit",
  pop: "exit",
  remove: "exit",
};

function readWorktreeOperation(options: unknown): WorktreeOperation | undefined {
  for (const key of ["action", "subaction", "op", "operation", "verb"]) {
    const raw = readStringParam(options, key);
    if (!raw) continue;
    const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
    if ((WORKTREE_OPERATIONS as readonly string[]).includes(normalized)) {
      return normalized as WorktreeOperation;
    }
    const alias = WORKTREE_OPERATION_ALIASES[normalized];
    if (alias) return alias;
  }
  return undefined;
}

export const worktreeAction: Action = {
  name: "WORKTREE",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: [
    "ENTER_WORKTREE",
    "EXIT_WORKTREE",
    "GIT_WORKTREE_ADD",
    "GIT_WORKTREE_REMOVE",
  ],
  description:
    "Manage the current git worktree stack. Choose action=enter to create and switch into an isolated worktree, or action=exit to leave the current worktree and optionally remove it.",
  descriptionCompressed: "Git worktree umbrella: action=enter/exit.",
  parameters: [
    {
      name: "action",
      description: "Worktree operation to run.",
      required: true,
      schema: { type: "string", enum: [...WORKTREE_OPERATIONS] },
    },
    {
      name: "name",
      description:
        "For action=enter, optional worktree branch/dir name. Defaults to auto-*.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "path",
      description:
        "For action=enter, optional absolute worktree directory within sandbox roots.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "base",
      description: "For action=enter, optional base ref. Defaults to HEAD.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "cleanup",
      description:
        "For action=exit, remove the popped worktree directory with git worktree remove --force.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const operation = readWorktreeOperation(options);
    if (!operation) {
      return failureToActionResult({
        reason: "missing_param",
        message: "WORKTREE requires action=enter/exit",
      });
    }
    const handler = WORKTREE_ACTIONS[operation];
    const result = await handler(
      runtime,
      message,
      state,
      options as HandlerOptions | undefined,
      callback,
    );
    return (
      result ??
      failureToActionResult({
        reason: "internal",
        message: `WORKTREE action=${operation} returned no result`,
      })
    );
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Enter a worktree for feature/login.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Entered a new worktree.",
          actions: ["WORKTREE"],
          thought: "Creating a git worktree maps to WORKTREE with action=enter.",
        },
      },
    ],
  ],
};
