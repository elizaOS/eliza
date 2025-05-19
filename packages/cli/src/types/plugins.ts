// Base types for plugin resolution
export interface GitResolutionDetail {
  kind: 'github';
  branch: string | null;
  coreDependency: string | null;
}

export interface NpmResolutionDetail {
  kind: 'npm';
  npmVersion: string | null;
}

export interface VersionResolution {
  version: string | null;
  source: 'git' | 'npm' | null;
  resolutionDetail?: GitResolutionDetail | NpmResolutionDetail;
}

// Plugin information types
export interface PluginInfo {
  registryKey: string;
  npmQueryName: string;
  githubLocator: string | null;
  isOfficialRepo: boolean;
  versions: {
    v0: VersionResolution;
    v1: VersionResolution;
  };
  errors: string[];
}

export interface CachedRegistry {
  lastUpdatedAt: string;
  plugins: Record<string, PluginInfo>;
}

// Raw registry types
export type RawRegistry = Record<string, string>; // <npmName> → "github:owner/repo"

export interface VersionInfo {
  git?: {
    v0?: {
      version: string | null;
      branch: string | null;
    };
    v1?: {
      version: string | null;
      branch: string | null;
    };
  };
  npm?: {
    v0?: string;
    v1?: string;
    exists: boolean;
  };
  supports: {
    v0: boolean;
    v1: boolean;
  };
}
