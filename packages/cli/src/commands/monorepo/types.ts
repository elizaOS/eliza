/**
 * Options for the monorepo command
 */
export interface MonorepoOptions {
  branch?: string;
  dir?: string;
}

/**
 * Information about the cloning operation
 */
export interface CloneInfo {
  repo: string;
  branch: string;
  destination: string;
}

/**
 * Platform-specific installation instructions
 */
export interface PlatformInstructions {
  platform: string;
  commands: string[];
  alternatives?: string[];
}
