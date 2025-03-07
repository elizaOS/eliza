import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from './logger';
import { getPackageVersion } from './get-package-info';

/**
 * Copy a directory recursively
 */
export async function copyDir(src: string, dest: string, exclude: string[] = []) {
  // Create destination directory if it doesn't exist
  await fs.mkdir(dest, { recursive: true });
  
  // Read source directory
  const entries = await fs.readdir(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    // Skip excluded directories/files
    if (exclude.includes(entry.name)) {
      continue;
    }
    
    // Skip node_modules, dist directories and .git directories
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || 
        entry.name === 'content_cache' || entry.name === 'data' || entry.name === 'generatedImages' ||
        entry.name === '.turbo') {
      continue;
    }
    
    if (entry.isDirectory()) {
      // Recursively copy directory
      await copyDir(srcPath, destPath, exclude);
    } else {
      // Copy file
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Copy a project or plugin template to target directory
 */
export async function copyTemplate(templateType: 'project' | 'plugin', targetDir: string, name: string) {
  // In development mode, use the actual packages
  let templateDir;

  if (process.env.NODE_ENV === 'development') {
    // Use local packages during development
    templateDir = path.resolve(
      process.cwd(),
      'packages',
      templateType === 'project' ? 'project-starter' : 'plugin-starter'
    );
  } else {
    // In production, use the templates directory from the CLI package
    templateDir = path.resolve(
      path.dirname(require.resolve('@elizaos/cli/package.json')),
      'templates', 
      templateType === 'project' ? 'project-starter' : 'plugin-starter'
    );
  }
  
  logger.info(`Copying ${templateType} template from ${templateDir} to ${targetDir}`);
  
  // Copy template files
  await copyDir(templateDir, targetDir);
  
  // Update package.json with new name and dependency versions
  const packageJsonPath = path.join(targetDir, 'package.json');
  
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    
    // Set project name
    packageJson.name = name;
    
    // Process dependencies - set all @elizaos/* packages to use "latest"
    if (packageJson.dependencies) {
      for (const depName of Object.keys(packageJson.dependencies)) {
        if (depName.startsWith('@elizaos/')) {
          logger.info(`Setting ${depName} to use latest version dynamically`);
          packageJson.dependencies[depName] = 'latest';
        }
      }
    }
    
    // Process devDependencies if they exist
    if (packageJson.devDependencies) {
      for (const depName of Object.keys(packageJson.devDependencies)) {
        if (depName.startsWith('@elizaos/')) {
          logger.info(`Setting dev dependency ${depName} to use latest version dynamically`);
          packageJson.devDependencies[depName] = 'latest';
        }
      }
    }
    
    // Write the updated package.json
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    logger.success(`Updated package.json with project name and latest dependencies`);
  } catch (error) {
    logger.error(`Error updating package.json: ${error}`);
  }
  
  logger.success(`${templateType} template copied successfully`);
} 