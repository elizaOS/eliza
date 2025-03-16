import type { ASTQueueItem } from '../../types';

/**
 * Interface representing a group of documentation for files.
 *
 * @property {string} filePath - The file path for the group of documentation.
 * @property {ASTQueueItem[]} classes - An array of ASTQueueItem objects representing classes in the file.
 * @property {ASTQueueItem[]} methods - An array of ASTQueueItem objects representing methods in the file.
 * @property {ASTQueueItem[]} interfaces - An array of ASTQueueItem objects representing interfaces in the file.
 * @property {ASTQueueItem[]} types - An array of ASTQueueItem objects representing types in the file.
 * @property {ASTQueueItem[]} functions - An array of ASTQueueItem objects representing functions in the file.
 */
export interface FileDocsGroup {
  filePath: string;
  classes: ASTQueueItem[];
  methods: ASTQueueItem[];
  interfaces: ASTQueueItem[];
  types: ASTQueueItem[];
  functions: ASTQueueItem[];
}

/**
 * Interface representing a collection of organized documentation items.
 * @property {ASTQueueItem[]} classes - An array of ASTQueueItem objects representing classes.
 * @property {ASTQueueItem[]} methods - An array of ASTQueueItem objects representing methods.
 * @property {ASTQueueItem[]} interfaces - An array of ASTQueueItem objects representing interfaces.
 * @property {ASTQueueItem[]} types - An array of ASTQueueItem objects representing types.
 * @property {ASTQueueItem[]} functions - An array of ASTQueueItem objects representing functions.
 * @property {ASTQueueItem[]} variables - An array of ASTQueueItem objects representing variables.
 */
export interface OrganizedDocs {
  classes: ASTQueueItem[];
  methods: ASTQueueItem[];
  interfaces: ASTQueueItem[];
  types: ASTQueueItem[];
  functions: ASTQueueItem[];
  variables: ASTQueueItem[];
}
