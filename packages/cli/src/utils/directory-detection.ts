import * as fs from 'node:fs';
import * as path from 'node:path';
import { UserEnvironment } from './user-environment';

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
  elizaPackageCount: number;
  monorepoRoot?: string;
}

interface PackageJson {
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

/**
 * Detects the type of directory and provides comprehensive information about it
 * @param dir The directory path to analyze
 * @returns DirectoryInfo object with detection results
 */
export function detectDirectoryType(dir: string): DirectoryInfo {
  // Check if directory exists and is readable
  if (!fs.existsSync(dir)) {
    return {
      type: 'non-elizaos-dir',
      hasPackageJson: false,
      hasElizaOSDependencies: false,
      elizaPackageCount: 0,
    };
  }

  try {
    fs.readdirSync(dir);
  } catch (error) {
    return {
      type: 'non-elizaos-dir',
      hasPackageJson: false,
      hasElizaOSDependencies: false,
      elizaPackageCount: 0,
    };
  }

  // Check for monorepo root
  const monorepoRoot = UserEnvironment.getInstance().findMonorepoRoot(dir) ?? undefined;

  // Check for package.json
  const packageJsonPath = path.join(dir, 'package.json');
  const hasPackageJson = fs.existsSync(packageJsonPath);

  if (monorepoRoot) {
    // If the current directory IS the monorepo root, classify as monorepo
    if (path.resolve(dir) === path.resolve(monorepoRoot)) {
      return {
        type: 'elizaos-monorepo',
        hasPackageJson,
        hasElizaOSDependencies: false,
        elizaPackageCount: 0,
        monorepoRoot,
      };
    }

    // If we're inside the monorepo but don't have package.json, it's a subdirectory
    if (!hasPackageJson) {
      return {
        type: 'elizaos-subdir',
        hasPackageJson: false,
        hasElizaOSDependencies: false,
        elizaPackageCount: 0,
        monorepoRoot,
      };
    }
  } else if (!hasPackageJson) {
    // Not in monorepo and no package.json
    return {
      type: 'non-elizaos-dir',
      hasPackageJson: false,
      hasElizaOSDependencies: false,
      elizaPackageCount: 0,
      monorepoRoot,
    };
  }

  // Parse package.json
  let packageJson: PackageJson;
  try {
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
    packageJson = JSON.parse(packageJsonContent);
  } catch (error) {
    return {
      type: 'non-elizaos-dir',
      hasPackageJson: true,
      hasElizaOSDependencies: false,
      elizaPackageCount: 0,
      monorepoRoot,
    };
  }

  // Create result object
  const result: DirectoryInfo = {
    type: 'non-elizaos-dir', // Default, will be updated below
    hasPackageJson: true,
    hasElizaOSDependencies: false,
    elizaPackageCount: 0,
    packageName: packageJson.name,
    monorepoRoot,
  };

  // Check for ElizaOS dependencies
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const elizaPackages = Object.keys(dependencies).filter((pkg) => pkg.startsWith('@elizaos/'));
  result.elizaPackageCount = elizaPackages.length;
  result.hasElizaOSDependencies = elizaPackages.length > 0;

  // Determine if this is an ElizaOS plugin
  const isPlugin = isElizaOSPlugin(packageJson);
  if (isPlugin) {
    result.type = 'elizaos-plugin';
    return result;
  }

  // Determine if this is an ElizaOS project
  const isProject = isElizaOSProject(packageJson, dir, monorepoRoot);
  if (isProject) {
    result.type = 'elizaos-project';
    return result;
  }

  // If inside monorepo and not a project or plugin → elizaos-subdir
  // If outside monorepo and not a project or plugin → non-elizaos-dir
  if (monorepoRoot) {
    result.type = 'elizaos-subdir';
  } else {
    result.type = 'non-elizaos-dir';
  }

  return result;
}

/**
 * Checks if a package.json indicates an ElizaOS plugin
 */
function isElizaOSPlugin(packageJson: PackageJson): boolean {
  // 1. EXPLICIT indicators first (most reliable)

  // Check packageType field (used in plugin templates)
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

  // 2. FALLBACK to package name patterns
  const packageName = packageJson.name || '';
  if (
    packageName.startsWith('@elizaos/plugin-') ||
    packageName.startsWith('plugin-') ||
    packageName.includes('/plugin-') ||
    (packageName.includes('plugin') && packageName.includes('eliza'))
  ) {
    return true;
  }

  // 3. OTHER heuristics (least reliable)
  if (
    packageJson.main &&
    (packageJson.main.includes('plugin') ||
      packageJson.main === 'src/index.ts' ||
      packageJson.main === 'dist/index.js')
  ) {
    // Additional check for plugin-like dependencies
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const hasElizaCore = Object.keys(allDeps).some((dep) => dep.startsWith('@elizaos/core'));
    if (hasElizaCore && keywords.length > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a package.json and directory structure indicates an ElizaOS project
 */
function isElizaOSProject(packageJson: PackageJson, dir: string, monorepoRoot?: string): boolean {
  // 1. EXPLICIT indicators first (most reliable)

  // Check packageType field (used in project templates)
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

  // 2. FALLBACK to package name patterns
  const packageName = packageJson.name || '';
  if (
    packageName.startsWith('@elizaos/project-') ||
    packageName.startsWith('project-') ||
    packageName.includes('/project-') ||
    (packageName.includes('project') && packageName.includes('eliza'))
  ) {
    return true;
  }

  // 3. OTHER heuristics (only when outside monorepo to avoid false positives)
  if (!monorepoRoot) {
    // Check src/index.ts content
    const srcIndexPath = path.join(dir, 'src', 'index.ts');
    if (fs.existsSync(srcIndexPath)) {
      try {
        const indexContent = fs.readFileSync(srcIndexPath, 'utf8');
        if (
          indexContent.includes('export const project') ||
          indexContent.includes('Project') ||
          indexContent.includes('agents')
        ) {
          return true;
        }
      } catch {
        // Ignore read errors
      }
    }

    // Check for character files (common in ElizaOS projects)
    const characterFiles = ['character.json', 'characters.json', 'characters'];
    for (const file of characterFiles) {
      if (fs.existsSync(path.join(dir, file))) {
        return true;
      }
    }

    // Check for project-specific directories
    const projectDirs = ['characters', 'agents', '.eliza'];
    for (const dirName of projectDirs) {
      if (fs.existsSync(path.join(dir, dirName))) {
        const stat = fs.statSync(path.join(dir, dirName));
        if (stat.isDirectory()) {
          return true;
        }
      }
    }

    // Check for project dependencies pattern
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const hasElizaCore = Object.keys(allDeps).some((dep) => dep.startsWith('@elizaos/core'));
    const hasMultipleElizaPackages =
      Object.keys(allDeps).filter((dep) => dep.startsWith('@elizaos/')).length >= 2;

    if (hasElizaCore && hasMultipleElizaPackages) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if the directory is suitable for ElizaOS package updates
 */
export function isValidForUpdates(info: DirectoryInfo): boolean {
  return (
    info.type === 'elizaos-project' ||
    info.type === 'elizaos-plugin' ||
    info.type === 'elizaos-monorepo' ||
    info.type === 'elizaos-subdir'
  );
}
