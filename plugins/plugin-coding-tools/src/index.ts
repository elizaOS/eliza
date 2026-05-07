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
  webSearchAction,
  writeAction,
} from "./actions/index.js";
import { availableToolsProvider } from "./providers/available-tools.js";
import {
  BashAstService,
  FileStateService,
  OsSandboxService,
  RipgrepService,
  SandboxService,
  SessionCwdService,
  ShellTaskService,
} from "./services/index.js";

export const codingToolsPlugin: Plugin = {
  name: "coding-tools",
  description:
    "Native Claude-Code-style coding tools. READ, WRITE, EDIT, NOTEBOOK_EDIT, BASH (+ TASK_OUTPUT, TASK_STOP for backgrounded jobs), GREP, GLOB, LS, WEB_FETCH, WEB_SEARCH, TODO_WRITE, ASK_USER_QUESTION, ENTER_WORKTREE, EXIT_WORKTREE. All file paths must be absolute. All operations are sealed to configured workspace roots.",
  services: [
    FileStateService,
    SandboxService,
    SessionCwdService,
    RipgrepService,
    ShellTaskService,
    BashAstService,
    OsSandboxService,
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
    webSearchAction,
    todoWriteAction,
    askUserQuestionAction,
    enterWorktreeAction,
    exitWorktreeAction,
  ],
};

export default codingToolsPlugin;

export {
  BashAstService,
  FileStateService,
  OsSandboxService,
  RipgrepService,
  SandboxService,
  SessionCwdService,
  ShellTaskService,
} from "./services/index.js";
export { availableToolsProvider } from "./providers/available-tools.js";
export * from "./types.js";
