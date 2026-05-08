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
  readAction,
  webFetchAction,
  webSearchAction,
  writeAction,
} from "./actions/index.js";
import { availableToolsProvider } from "./providers/available-tools.js";
import {
  FileStateService,
  RipgrepService,
  SandboxService,
  SessionCwdService,
} from "./services/index.js";

export const codingToolsPlugin: Plugin = {
  name: "coding-tools",
  description:
    "Native Claude-Code-style coding tools. READ, WRITE, EDIT, BASH, GREP, GLOB, LS, WEB_FETCH, CODE_WEB_SEARCH, ASK_USER_QUESTION, ENTER_WORKTREE, EXIT_WORKTREE. The TODO umbrella action (op-based CRUD: write/create/update/complete/cancel/delete/list/clear) is provided by @elizaos/plugin-todos. All file paths must be absolute. Blocks user-private + per-OS system paths by default.",
  services: [
    FileStateService,
    SandboxService,
    SessionCwdService,
    RipgrepService,
  ],
  providers: [availableToolsProvider],
  actions: [
    readAction,
    writeAction,
    editAction,
    bashAction,
    grepAction,
    globAction,
    lsAction,
    webFetchAction,
    webSearchAction,
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
} from "./services/index.js";
export { availableToolsProvider } from "./providers/available-tools.js";
export * from "./types.js";
