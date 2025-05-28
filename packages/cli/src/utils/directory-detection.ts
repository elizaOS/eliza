import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DirectoryInfo {
  type: 'elizaos-project' | 'elizaos-plugin' | 'empty' | 'non-elizaos-project' | 'invalid';
  hasPackageJson: boolean;
  hasElizaOSDependencies: boolean;
  isEmpty: boolean;
  packageName?: string;
  elizaPackageCount: number;
}

interface PackageJson {
  name?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  eliza?: {
    type?: string;
  };
}

/**
 * Detects the type of directory and provides comprehensive information about it
 * @param dir The directory path to analyze
 * @returns DirectoryInfo object with detection results
 */
export function detectDirectoryType(dir: string): DirectoryInfo {
  const result: DirectoryInfo = {
    type: 'invalid',
    hasPackageJson: false,
    hasElizaOSDependencies: false,
    isEmpty: false,
    elizaPackageCount: 0,
  };

  // Check if directory exists
  if (!fs.existsSync(dir)) {
    return result;
  }

  // Check if directory is empty
  try {
    const files = fs.readdirSync(dir);
    const visibleFiles = files.filter((file) => !file.startsWith('.'));
    result.isEmpty = visibleFiles.length === 0;

    if (result.isEmpty) {
      result.type = 'empty';
      return result;
    }
  } catch (error) {
    return result; // Cannot read directory
  }

  // Check for package.json
  const packageJsonPath = path.join(dir, 'package.json');
  result.hasPackageJson = fs.existsSync(packageJsonPath);

  if (!result.hasPackageJson) {
    result.type = 'invalid';
    return result;
  }

  // Parse package.json
  let packageJson: PackageJson;
  try {
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
    packageJson = JSON.parse(packageJsonContent);
    result.packageName = packageJson.name;
  } catch (error) {
    result.type = 'invalid';
    return result;
  }

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
  const isProject = isElizaOSProject(packageJson, dir);
  if (isProject) {
    result.type = 'elizaos-project';
    return result;
  }

  // If it has ElizaOS dependencies but isn't clearly a project or plugin,
  // it might still be an ElizaOS project with non-standard structure
  if (result.hasElizaOSDependencies) {
    result.type = 'elizaos-project';
    return result;
  }

  // Otherwise, it's a non-ElizaOS project
  result.type = 'non-elizaos-project';
  return result;
}

/**
 * Checks if a package.json indicates an ElizaOS plugin
 */
function isElizaOSPlugin(packageJson: PackageJson): boolean {
  // Check keywords (primary detection method)
  const keywords = packageJson.keywords || [];
  if (keywords.includes('plugin')) {
    return true;
  }

  // Check package name patterns
  if (packageJson.name?.startsWith('@elizaos/plugin-') || packageJson.name?.includes('plugin-')) {
    return true;
  }

  return false;
}

/**
 * Checks if a package.json and directory structure indicates an ElizaOS project
 */
function isElizaOSProject(packageJson: PackageJson, dir: string): boolean {
  // Check keywords (primary detection method)
  const keywords = packageJson.keywords || [];
  if (keywords.includes('project')) {
    return true;
  }

  // Check for project-like structure
  const srcIndexPath = path.join(dir, 'src', 'index.ts');
  if (fs.existsSync(srcIndexPath)) {
    try {
      const indexContent = fs.readFileSync(srcIndexPath, 'utf8');
      if (
        indexContent.includes('export const project') ||
        (indexContent.includes('export default') && indexContent.includes('Project'))
      ) {
        return true;
      }
    } catch {
      // Ignore read errors
    }
  }

  // Check for character files (common in ElizaOS projects)
  const characterFiles = ['character.json', 'characters.json'];
  for (const file of characterFiles) {
    if (fs.existsSync(path.join(dir, file))) {
      return true;
    }
  }

  return false;
}

/**
 * Gets a user-friendly description of the directory type
 */
export function getDirectoryTypeDescription(info: DirectoryInfo): string {
  switch (info.type) {
    case 'elizaos-project':
      return 'ElizaOS project';
    case 'elizaos-plugin':
      return 'ElizaOS plugin';
    case 'empty':
      return 'empty directory';
    case 'non-elizaos-project':
      return 'non-ElizaOS project';
    case 'invalid':
      return 'invalid or inaccessible directory';
    default:
      return 'unknown directory type';
  }
}

/**
 * Checks if the directory is suitable for ElizaOS package updates
 */
export function isValidForUpdates(info: DirectoryInfo): boolean {
  return info.type === 'elizaos-project' || info.type === 'elizaos-plugin';
}
