import type { Plugin } from "@elizaos/core";
import {
  askUserQuestionAction,
  bashAction,
  editAction,
  enterWorktreeAction,
  exitWorktreeAction,
  globAction,
  grepAction,
  lsAction,
  notebookEditAction,
  readAction,
  taskOutputAction,
  taskStopAction,
  todoWriteAction,
  webFetchAction,
  writeAction,
} from "./actions/index.js";
import { availableToolsProvider } from "./providers/available-tools.js";
import {
  FileStateService,
  RipgrepService,
  SandboxService,
  SessionCwdService,
  ShellTaskService,
} from "./services/index.js";

export const codingToolsPlugin: Plugin = {
  name: "coding-tools",
  description:
    "Native Claude-Code-style coding tools. READ, WRITE, EDIT, NOTEBOOK_EDIT, BASH (+ TASK_OUTPUT, TASK_STOP for backgrounded jobs), GREP, GLOB, LS, WEB_FETCH, TODO_WRITE, ASK_USER_QUESTION, ENTER_WORKTREE, EXIT_WORKTREE. All file paths must be absolute. Blocks user-private paths (~/pvt, ~/Library, ~/.ssh, etc.) by default; otherwise unrestricted.",
  services: [
    FileStateService,
    SandboxService,
    SessionCwdService,
    RipgrepService,
    ShellTaskService,
  ],
  providers: [availableToolsProvider],
  actions: [
    readAction,
    writeAction,
    editAction,
    notebookEditAction,
    bashAction,
    taskOutputAction,
    taskStopAction,
    grepAction,
    globAction,
    lsAction,
    webFetchAction,
    todoWriteAction,
    askUserQuestionAction,
    enterWorktreeAction,
    exitWorktreeAction,
  ],
};

export default codingToolsPlugin;

export {
  FileStateService,
  RipgrepService,
  SandboxService,
  SessionCwdService,
  ShellTaskService,
} from "./services/index.js";
export { availableToolsProvider } from "./providers/available-tools.js";
export * from "./types.js";
