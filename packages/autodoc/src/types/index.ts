import type { TSESTree } from '@typescript-eslint/types';

/**
 * Represents an item in the Abstract Syntax Tree (AST) queue.
 *
 * @typedef {Object} ASTQueueItem
 * @property {string} name - The name of the item.
 * @property {string} filePath - The file path of the item.
 * @property {number} startLine - The starting line number of the item.
 * @property {number} endLine - The ending line number of the item.
 * @property {string} nodeType - The type of node in the AST.
 * @property {string} code - The code snippet of the item.
 * @property {string} [className] - The class name of the item (if applicable).
 * @property {string} [methodName] - The method name of the item (if applicable).
 * @property {string} [jsDoc] - The JSDoc comment associated with the item.
 */
export interface ASTQueueItem {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType: string;
  code: string;
  className?: string;
  methodName?: string;
  jsDoc?: string;
}

/**
 * Represents a repository.
 * @typedef {Object} Repository
 * @property {string} owner - The owner of the repository.
 * @property {string} name - The name of the repository.
 * @property {number} [pullNumber] - The pull number of the repository (optional).
 */
export interface Repository {
  owner: string;
  name: string;
  pullNumber?: number;
}

/**
 * Represents a file change in full mode.
 * @typedef {Object} FullModeFileChange
 * @property {string} filename - The name of the file that has changed.
 * @property {string} status - The status of the file change.
 */
export interface FullModeFileChange {
  filename: string;
  status: string;
}

/**
 * Interface representing a Pull Request mode file change, extending Full Mode File Change.
 * @interface
 * @extends {FullModeFileChange}
 * @property {number} additions - The number of additions made in the file change.
 * @property {number} deletions - The number of deletions made in the file change.
 * @property {number} changes - The total number of changes (additions + deletions) in the file change.
 * @property {string} contents_url - The URL to the contents of the file change.
 */
export interface PrModeFileChange extends FullModeFileChange {
  additions: number;
  deletions: number;
  changes: number;
  contents_url: string;
}

/**
 * Interface representing a section of todos.
 * @typedef {object} TodoSection
 * @property {string} todos - The list of todos in the section.
 * @property {number} todoCount - The number of todos in the section.
 */
export interface TodoSection {
  todos: string;
  todoCount: number;
}

/**
 * Interface representing a todo item.
 * @typedef {Object} TodoItem
 * @property {string} comment - The comment describing the todo item.
 * @property {string} code - The code related to the todo item.
 * @property {string} fullContext - The full context of the todo item.
 * @property {TSESTree.Node} node - The AST node related to the todo item.
 * @property {Object} location - The location information of the todo item.
 * @property {Object} location.start - The start location of the todo item.
 * @property {number} location.start.line - The start line of the todo item.
 * @property {number} location.start.column - The start column of the todo item.
 * @property {Object} location.end - The end location of the todo item.
 * @property {number} location.end.line - The end line of the todo item.
 * @property {number} location.end.column - The end column of the todo item.
 * @property {Object} contextLocation - The context location information of the todo item.
 * @property {Object} contextLocation.start - The start context location of the todo item.
 * @property {number} contextLocation.start.line - The start line of the todo item context.
 * @property {number} contextLocation.start.column - The start column of the todo item context.
 * @property {Object} contextLocation.end - The end context location of the todo item.
 * @property {number} contextLocation.end.line - The end line of the todo item context.
 * @property {number} contextLocation.end.column - The end column of the todo item context.
 */
export interface TodoItem {
  comment: string;
  code: string;
  fullContext: string;
  node: TSESTree.Node;
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  contextLocation: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

/**
 * Represents the usage of a particular environment variable in the code.
 * @interface EnvUsage
 * @property {string} code - The code snippet where the environment variable is used.
 * @property {string} context - The context in which the environment variable is used.
 * @property {string} fullContext - The full context of the environment variable.
 * @property {TSESTree.Node} node - The AST node where the environment variable is used.
 * @property {Object} location - The location of the environment variable in the code.
 * @property {Object} location.start - The start line and column of the environment variable in the code.
 * @property {number} location.start.line - The start line number of the environment variable.
 * @property {number} location.start.column - The start column number of the environment variable.
 * @property {Object} location.end - The end line and column of the environment variable in the code.
 * @property {number} location.end.line - The end line number of the environment variable.
 * @property {number} location.end.column - The end column number of the environment variable.
 * @property {Object} contextLocation - The location of the context in the code where the environment variable is used.
 * @property {Object} contextLocation.start - The start line and column of the context in the code.
 * @property {number} contextLocation.start.line - The start line number of the context.
 * @property {number} contextLocation.start.column - The start column number of the context.
 * @property {Object} contextLocation.end - The end line and column of the context in the code.
 * @property {number} contextLocation.end.line - The end line number of the context.
 * @property {number} contextLocation.end.column - The end column number of the context.
 */
export interface EnvUsage {
  code: string;
  context: string;
  fullContext: string;
  node: TSESTree.Node;
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  contextLocation: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

/**
 * Interface for representing the documentation structure of a plugin.
 * Includes sections for overview, installation, configuration, usage,
 * API reference, troubleshooting, todos, actions documentation,
 * providers documentation, evaluators documentation, and FAQ.
 *
 * @interface
 * @property {string} overview - Overview section of the documentation.
 * @property {string} installation - Installation section of the documentation.
 * @property {string} configuration - Configuration section of the documentation.
 * @property {string} usage - Usage section of the documentation.
 * @property {string} apiReference - API reference section of the documentation.
 * @property {string} troubleshooting - Troubleshooting section of the documentation.
 * @property {string} todos - Todos section of the documentation.
 * @property {string} actionsDocumentation - Actions documentation section of the documentation.
 * @property {string} providersDocumentation - Providers documentation section of the documentation.
 * @property {string} evaluatorsDocumentation - Evaluators documentation section of the documentation.
 * @property {string} faq - FAQ section of the documentation.
 */

export interface PluginDocumentation {
  overview: string;
  installation: string;
  configuration: string;
  usage: string;
  apiReference: string;
  troubleshooting: string;
  todos: string;
  actionsDocumentation: string;
  providersDocumentation: string;
  evaluatorsDocumentation: string;
  faq: string;
}

/**
 * Interface for defining metadata for an action.
 * @interface
 * @property {string} name - The name of the action.
 * @property {string[]} similes - An array of similes related to the action.
 * @property {string} validate - The validation method for the action.
 * @property {string} handler - The handler method for the action.
 * @property {string[]} examples - An array of example scenarios for the action.
 * @property {string} description - A brief description of the action.
 */
export interface ActionMetadata {
  name: string;
  similes: string[];
  validate: string;
  handler: string;
  examples: string[];
  description: string;
}

/**
 * Interface representing the bounds of an action in terms of start and end line numbers.
 * @typedef {Object} ActionBounds
 * @property {number} startLine - The line number where the action begins.
 * @property {number} endLine - The line number where the action ends.
 */
export interface ActionBounds {
  startLine: number;
  endLine: number;
}
