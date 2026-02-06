/**
 * OpenProse VM types
 */

export type ProseStateMode = "filesystem" | "in-context" | "sqlite" | "postgres";

export interface ProseRunOptions {
  /** Path to the .prose file */
  file: string;
  /** State management mode */
  stateMode?: ProseStateMode;
  /** Input arguments as JSON */
  inputsJson?: string;
  /** Working directory */
  cwd?: string;
}

export interface ProseCompileOptions {
  /** Path to the .prose file */
  file: string;
}

export interface ProseRunResult {
  success: boolean;
  runId?: string;
  outputs?: Record<string, unknown>;
  error?: string;
}

export interface ProseCompileResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface ProseSkillFile {
  name: string;
  path: string;
  content: string;
}

export interface ProseConfig {
  /** Base directory for .prose workspace */
  workspaceDir?: string;
  /** Default state mode */
  defaultStateMode?: ProseStateMode;
}
