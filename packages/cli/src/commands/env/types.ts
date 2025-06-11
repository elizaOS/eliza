/**
 * Environment command options for different subcommands
 */
export interface ListEnvOptions {
  system?: boolean;
  local?: boolean;
}

export interface EditEnvOptions {
  yes?: boolean;
}

export interface ResetEnvOptions {
  yes?: boolean;
}

export interface InteractiveEnvOptions {
  yes?: boolean;
}

/**
 * Reset operation types
 */
export type ResetTarget = 'localEnv' | 'cache' | 'localDb';
export type ResetAction = 'reset' | 'deleted' | 'skipped' | 'warning';

/**
 * Reset item configuration
 */
export interface ResetItem {
  title: string;
  value: ResetTarget;
  description?: string;
  selected?: boolean;
}

/**
 * Environment variable record type
 */
export type EnvVars = Record<string, string>;

/**
 * Reset operation result tracking
 */
export type ResetActionRecord = Record<ResetAction, string[]>;
