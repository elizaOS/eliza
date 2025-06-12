import * as fs from 'node:fs';
import * as path from 'node:path';
import { UserEnvironment } from './user-environment';

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

export interface DirectoryInfo {
  type:
    | 'elizaos-project'
    | 'elizaos-plugin'
    | 'elizaos-monorepo'
    | 'elizaos-subdir'
    | 'non-elizaos-dir';
  hasPackageJson: boolean;
  hasElizaOSDependencies: boolean;
  packageName?: string;
  packageInfo?: PackageJson;
  elizaPackageCount: number;
  monorepoRoot?: string;

  // Convenience boolean flags - no need to import separate functions
  isProject: boolean;
  isPlugin: boolean;
  isMonorepo: boolean;
  isSubdir: boolean;
  isNonElizaOS: boolean;
}

export interface PackageJson {
  name?: string;
  keywords?: string[];
  main?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageType?: string;
  agentConfig?: {
    pluginType?: string;
    [key: string]: any;
  };
}

// ============================================================================
// MAIN DETECTION FUNCTION
// ============================================================================

/**
 * Detects the type of directory and provides comprehensive information about it
 * @param dir The directory path to analyze
 * @returns DirectoryInfo object with detection results and convenience boolean flags
 */
export function detectDirectoryType(dir: string): DirectoryInfo {
  // Early exit for invalid directories
  if (!isValidDirectory(dir)) {
    return createDirectoryInfo('non-elizaos-dir', false, 0, false);
  }

  // Check monorepo context
  const monorepoRoot = UserEnvironment.getInstance().findMonorepoRoot(dir);

  // Handle monorepo root directory
  if (isMonorepoRootDirectory(dir, monorepoRoot)) {
    const packageJsonPath = path.join(dir, 'package.json');
    const hasPackageJson = fs.existsSync(packageJsonPath);

    let elizaPackageCount = 0;
    let packageName: string | undefined;
    let packageInfo: PackageJson | undefined;

    if (hasPackageJson) {
      packageInfo = parsePackageJson(packageJsonPath);
      if (packageInfo) {
        elizaPackageCount = countElizaOSPackages(packageInfo);
        packageName = packageInfo.name;
      }
    }

    return createDirectoryInfo(
      'elizaos-monorepo',
      hasPackageJson,
      elizaPackageCount,
      elizaPackageCount > 0,
      monorepoRoot,
      packageName,
      packageInfo
    );
  }

  // Check for package.json
  const packageJsonPath = path.join(dir, 'package.json');
  const hasPackageJson = fs.existsSync(packageJsonPath);

  // Handle directories without package.json
  if (!hasPackageJson) {
    const type = monorepoRoot ? 'elizaos-subdir' : 'non-elizaos-dir';
    return createDirectoryInfo(type, false, 0, false, monorepoRoot);
  }

  // Parse package.json
  const packageInfo = parsePackageJson(packageJsonPath);
  if (!packageInfo) {
    return createDirectoryInfo('non-elizaos-dir', true, 0, false, monorepoRoot);
  }

  // Analyze ElizaOS dependencies
  const elizaPackageCount = countElizaOSPackages(packageInfo);
  const hasElizaOSDependencies = elizaPackageCount > 0;

  // Determine directory type flags directly from detection functions
  const isPlugin = isElizaOSPlugin(packageInfo);
  const isProject = isElizaOSProject(packageInfo, dir, monorepoRoot);

  // Derive the type string from the boolean flags
  let directoryType: DirectoryInfo['type'];
  if (isPlugin) {
    directoryType = 'elizaos-plugin';
  } else if (isProject) {
    directoryType = 'elizaos-project';
  } else {
    directoryType = monorepoRoot ? 'elizaos-subdir' : 'non-elizaos-dir';
  }

  return createDirectoryInfo(
    directoryType,
    true,
    elizaPackageCount,
    hasElizaOSDependencies,
    monorepoRoot,
    packageInfo.name,
    packageInfo
  );
}

// ============================================================================
// HELPER FUNCTIONS FOR MAIN DETECTION
// ============================================================================

function isValidDirectory(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;

  try {
    fs.readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function isMonorepoRootDirectory(dir: string, monorepoRoot?: string): boolean {
  return monorepoRoot && path.resolve(dir) === path.resolve(monorepoRoot);
}

function parsePackageJson(packageJsonPath: string): PackageJson | null {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function countElizaOSPackages(packageJson: PackageJson): number {
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  return Object.keys(dependencies).filter((pkg) => pkg.startsWith('@elizaos/')).length;
}

function createDirectoryInfo(
  type: DirectoryInfo['type'],
  hasPackageJson: boolean,
  elizaPackageCount: number,
  hasElizaOSDependencies: boolean,
  monorepoRoot?: string,
  packageName?: string,
  packageInfo?: PackageJson
): DirectoryInfo {
  return {
    type,
    hasPackageJson,
    hasElizaOSDependencies,
    elizaPackageCount,
    monorepoRoot,
    packageName,
    packageInfo,

    // Convenience boolean flags
    isProject: type === 'elizaos-project',
    isPlugin: type === 'elizaos-plugin',
    isMonorepo: type === 'elizaos-monorepo',
    isSubdir: type === 'elizaos-subdir',
    isNonElizaOS: type === 'non-elizaos-dir',
  };
}

// ============================================================================
// PLUGIN DETECTION LOGIC
// ============================================================================

/**
 * Checks if a package.json indicates an ElizaOS plugin
 * Uses explicit indicators first, then fallback patterns
 */
function isElizaOSPlugin(packageJson: PackageJson): boolean {
  // 1. EXPLICIT indicators (most reliable)
  if (hasExplicitPluginIndicators(packageJson)) {
    return true;
  }

  // 2. PACKAGE NAME patterns
  if (hasPluginNamePattern(packageJson)) {
    return true;
  }

  // 3. HEURISTIC checks (least reliable)
  if (hasPluginHeuristics(packageJson)) {
    return true;
  }

  return false;
}

function hasExplicitPluginIndicators(packageJson: PackageJson): boolean {
  // Check packageType field
  if (packageJson.packageType === 'plugin') {
    return true;
  }

  // Check keywords
  const keywords = packageJson.keywords || [];
  if (keywords.includes('plugin')) {
    return true;
  }

  // Check agentConfig.pluginType field
  if (packageJson.agentConfig?.pluginType?.includes('plugin')) {
    return true;
  }

  return false;
}

function hasPluginNamePattern(packageJson: PackageJson): boolean {
  const packageName = packageJson.name || '';
  return (
    packageName.startsWith('@elizaos/plugin-') ||
    packageName.startsWith('plugin-') ||
    packageName.includes('/plugin-') ||
    (packageName.includes('plugin') && packageName.includes('eliza'))
  );
}

function hasPluginHeuristics(packageJson: PackageJson): boolean {
  const main = packageJson.main;
  if (!main) return false;

  const hasPluginMainPath =
    main.includes('plugin') || main === 'src/index.ts' || main === 'dist/index.js';

  if (!hasPluginMainPath) return false;

  // Additional validation for heuristic matches
  const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const hasElizaCore = Object.keys(allDeps).some((dep) => dep.startsWith('@elizaos/core'));
  const keywords = packageJson.keywords || [];

  return hasElizaCore && keywords.length > 0;
}

// ============================================================================
// PROJECT DETECTION LOGIC
// ============================================================================

/**
 * Checks if a package.json and directory structure indicates an ElizaOS project
 * Uses explicit indicators first, then fallback patterns
 */
function isElizaOSProject(packageJson: PackageJson, dir: string, monorepoRoot?: string): boolean {
  // 1. EXPLICIT indicators (most reliable)
  if (hasExplicitProjectIndicators(packageJson)) {
    return true;
  }

  // 2. PACKAGE NAME patterns
  if (hasProjectNamePattern(packageJson)) {
    return true;
  }

  // 3. FILESYSTEM heuristics (only outside monorepo to avoid false positives)
  if (!monorepoRoot && hasProjectFileSystemHeuristics(packageJson, dir)) {
    return true;
  }

  return false;
}

function hasExplicitProjectIndicators(packageJson: PackageJson): boolean {
  // Check packageType field
  if (packageJson.packageType === 'project') {
    return true;
  }

  // Check keywords
  const keywords = packageJson.keywords || [];
  if (keywords.includes('project')) {
    return true;
  }

  // Check agentConfig for project indicators
  if (packageJson.agentConfig?.pluginType?.includes('project')) {
    return true;
  }

  return false;
}

function hasProjectNamePattern(packageJson: PackageJson): boolean {
  const packageName = packageJson.name || '';
  return (
    packageName.startsWith('@elizaos/project-') ||
    packageName.startsWith('project-') ||
    packageName.includes('/project-') ||
    (packageName.includes('project') && packageName.includes('eliza'))
  );
}

function hasProjectFileSystemHeuristics(packageJson: PackageJson, dir: string): boolean {
  // Check src/index.ts content
  if (hasProjectIndexContent(dir)) {
    return true;
  }

  // Check for character files
  if (hasCharacterFiles(dir)) {
    return true;
  }

  // Check for project-specific directories
  if (hasProjectDirectories(dir)) {
    return true;
  }

  // Check dependency patterns
  if (hasProjectDependencyPattern(packageJson)) {
    return true;
  }

  return false;
}

function hasProjectIndexContent(dir: string): boolean {
  const srcIndexPath = path.join(dir, 'src', 'index.ts');
  if (!fs.existsSync(srcIndexPath)) return false;

  try {
    const indexContent = fs.readFileSync(srcIndexPath, 'utf8');
    return (
      indexContent.includes('export const project') ||
      indexContent.includes('Project') ||
      indexContent.includes('agents')
    );
  } catch {
    return false;
  }
}

function hasCharacterFiles(dir: string): boolean {
  const characterFiles = ['character.json', 'characters.json', 'characters'];
  return characterFiles.some((file) => fs.existsSync(path.join(dir, file)));
}

function hasProjectDirectories(dir: string): boolean {
  const projectDirs = ['characters', 'agents', '.eliza'];
  return projectDirs.some((dirName) => {
    const fullPath = path.join(dir, dirName);
    try {
      return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  });
}

function hasProjectDependencyPattern(packageJson: PackageJson): boolean {
  const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const elizaDeps = Object.keys(allDeps).filter((dep) => dep.startsWith('@elizaos/'));
  const hasElizaCore = elizaDeps.some((dep) => dep.startsWith('@elizaos/core'));
  const hasMultipleElizaPackages = elizaDeps.length >= 2;

  return hasElizaCore && hasMultipleElizaPackages;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Checks if the directory is suitable for ElizaOS package updates
 */
export function isValidForUpdates(info: DirectoryInfo): boolean {
  return info.isProject || info.isPlugin || info.isMonorepo || info.isSubdir;
}
