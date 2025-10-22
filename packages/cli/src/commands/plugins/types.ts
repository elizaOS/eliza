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
