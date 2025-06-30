/**
 * Plugin command options for different subcommands
 */
export interface ListPluginsOptions {
  all?: boolean;
  v0?: boolean;
}

export interface AddPluginOptions {
  skipEnvPrompt?: boolean;
  skipVerification?: boolean;
  branch?: string;
  tag?: string;
}

export interface UpgradePluginOptions {
  apiKey?: string;
  skipTests?: boolean;
  skipValidation?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  skipConfirmation?: boolean;
}

export interface GeneratePluginOptions {
  apiKey?: string;
  skipTests?: boolean;
  skipValidation?: boolean;
  skipPrompts?: boolean;
  specFile?: string;
}

/**
 * Plugin registry interfaces
 */
export interface PluginRegistryInfo {
  git?: {
    repo: string;
    v0?: {
      version: string;
      branch: string;
    };
    v1?: {
      version: string;
      branch: string;
    };
  };
  npm?: {
    repo: string;
    v0?: string;
    v1?: string;
  };
  supports: {
    v0: boolean;
    v1: boolean;
  };
}

export interface PluginRegistry {
  registry: Record<string, PluginRegistryInfo>;
}

/**
 * Environment variable configuration
 */
export interface EnvVarConfig {
  type: string;
  description: string;
  required?: boolean;
  default?: string;
  sensitive?: boolean;
}

/**
 * Plugin migration result
 */
export interface MigrationResult {
  success: boolean;
  branchName?: string;
  repoPath?: string;
  error?: Error;
}

/**
 * Plugin generation result
 */
export interface GenerationResult {
  success: boolean;
  pluginName?: string;
  pluginPath?: string;
  error?: Error;
}

/**
 * Directory information from detection
 */
export interface DirectoryInfo {
  type: string;
  hasPackageJson: boolean;
}

/**
 * Package.json dependencies
 */
export type Dependencies = Record<string, string>;
