import type { Plugin } from "@elizaos/core";

// File operations
import { readFileAction } from "./actions/read-file.js";
import { writeFileAction } from "./actions/write-file.js";
import { editFileAction } from "./actions/edit-file.js";
import { listFilesAction } from "./actions/list-files.js";
import { searchFilesAction } from "./actions/search-files.js";
import { changeDirectoryAction } from "./actions/change-directory.js";

// Code intelligence
import { askAction } from "./actions/ask.js";
import { explainAction } from "./actions/explain.js";
import { reviewAction } from "./actions/review.js";
import { refactorAction } from "./actions/refactor.js";
import { fixAction } from "./actions/fix.js";
import { generateAction } from "./actions/generate.js";
import { testAction } from "./actions/test.js";
import { planAction } from "./actions/plan.js";

// Execution
import { executeShellAction } from "./actions/execute-shell.js";
import { gitAction } from "./actions/git.js";

// Task management
import { createTaskAction } from "./actions/create-task.js";
import {
  listTasksAction,
  switchTaskAction,
  searchTasksAction,
  pauseTaskAction,
  resumeTaskAction,
  cancelTaskAction,
} from "./actions/task-management.js";

// Services
import { CodeTaskService } from "./services/code-task.js";

// Providers
import { taskContextProvider } from "./providers/task-context.js";
import { cwdProvider } from "./providers/cwd.js";
import { timeProvider } from "./providers/time.js";
import { actionsProvider } from "./providers/actions.js";
import { actionStateProvider } from "./providers/actionState.js";
import { attachmentsProvider } from "./providers/attachments.js";
import { capabilitiesProvider } from "./providers/capabilities.js";
import { characterProvider } from "./providers/character.js";
import { providersProvider } from "./providers/providers.js";
import { recentMessagesProvider } from "./providers/recentMessages.js";

/**
 * Eliza Code Plugin
 *
 * Comprehensive coding assistant with:
 * - File operations (read, write, edit, list, search)
 * - Code intelligence (ask, explain, review, refactor, fix, generate, test)
 * - Shell command execution
 * - Git version control
 * - Background task management with sub-agent execution
 */
export const elizaCodePlugin: Plugin = {
  name: "eliza-code",
  description: "Coding assistant with full filesystem, shell access, and task management",

  actions: [
    // File operations
    readFileAction,
    writeFileAction,
    editFileAction,
    listFilesAction,
    searchFilesAction,
    changeDirectoryAction,
    // Code intelligence
    askAction,
    explainAction,
    reviewAction,
    refactorAction,
    fixAction,
    generateAction,
    testAction,
    planAction,

    // Execution
    executeShellAction,
    gitAction,

    // Task management
    createTaskAction,
    listTasksAction,
    switchTaskAction,
    searchTasksAction,
    pauseTaskAction,
    resumeTaskAction,
    cancelTaskAction,
  ],

  providers: [
    cwdProvider,
    taskContextProvider,
    timeProvider,
    actionsProvider,
    actionStateProvider,
    attachmentsProvider,
    capabilitiesProvider,
    characterProvider,
    providersProvider,
    recentMessagesProvider,
  ],

  services: [CodeTaskService],
};

// Named exports for direct use
export {
  // File operations
  readFileAction,
  writeFileAction,
  editFileAction,
  listFilesAction,
  searchFilesAction,
  changeDirectoryAction,
  // Code intelligence
  askAction,
  explainAction,
  reviewAction,
  refactorAction,
  fixAction,
  generateAction,
  testAction,
  planAction,

  // Execution
  executeShellAction,
  gitAction,

  // Task management
  createTaskAction,
  listTasksAction,
  switchTaskAction,
  searchTasksAction,
  pauseTaskAction,
  resumeTaskAction,
  cancelTaskAction,

  // Providers
  taskContextProvider,
  cwdProvider,
  timeProvider,
  actionsProvider,
  actionStateProvider,
  attachmentsProvider,
  capabilitiesProvider,
  characterProvider,
  providersProvider,
  recentMessagesProvider,

  // Services
  CodeTaskService,
};

// CWD utilities
export { getCwd, setCwd } from "./providers/cwd.js";

// Prompts and errors
export * from "../lib/prompts.js";
export * from "../lib/errors.js";

export default elizaCodePlugin;
