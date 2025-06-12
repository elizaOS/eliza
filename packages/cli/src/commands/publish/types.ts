/**
 * Package metadata interface for registry publication
 */
export interface PackageMetadata {
  name: string;
  version: string;
  description: string;
  type: string;
  platform: string;
  runtimeVersion: string;
  repository: string;
  maintainers: string[];
  publishedAt: string;
  publishedBy: string;
  dependencies: Record<string, string>;
  tags: string[];
  license: string;
  npmPackage?: string;
  githubRepo?: string;
}

/**
 * Publish command options
 */
export interface PublishOptions {
  npm?: boolean;
  test?: boolean;
  dryRun?: boolean;
  skipRegistry?: boolean;
}

/**
 * Credentials interface
 */
export interface Credentials {
  username: string;
  token: string;
}

/**
 * Directory information from detection
 */
export interface DirectoryInfo {
  type: string;
  hasPackageJson: boolean;
}

/**
 * Registry settings interface
 */
export interface RegistrySettings {
  defaultRegistry: string;
  publishConfig?: {
    registry: string;
    username: string;
    useNpm: boolean;
    platform: string;
  };
}

/**
 * Package.json structure with optional fields used in publishing
 */
export interface PackageJson {
  name: string;
  version: string;
  description?: string;
  type?: string;
  platform?: 'node' | 'browser' | 'universal';
  repository?: {
    type: string;
    url: string;
  };
  maintainers?: string[];
  dependencies?: Record<string, string>;
  keywords?: string[];
  license?: string;
  author?: string;
  bugs?: {
    url: string;
  };
  npmPackage?: string;
  githubRepo?: string;
  packageType?: 'plugin' | 'project';
  agentConfig?: {
    pluginType: string;
    pluginParameters: Record<string, any>;
  };
  eliza?: {
    type: string;
  };
}

/**
 * Placeholder replacement configuration
 */
export interface PlaceholderReplacement {
  check: () => boolean;
  replace: () => void;
}

/**
 * Publish result from GitHub publishing
 */
export type PublishResult = boolean | { success: boolean; prUrl?: string };
